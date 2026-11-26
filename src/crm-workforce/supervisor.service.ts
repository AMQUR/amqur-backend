import { Injectable, Logger } from '@nestjs/common';
import { CrmWfTask } from '@prisma/client';
import { TurnLockService } from '../chat/turn-lock.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { PrismaService } from '../prisma/prisma.service';
import { CrmWfDrafterService } from './agents/drafter.service';
import {
  defaultDisclosure,
  playbookChecksum,
  PROPOSED_IDENTITIES,
} from './agents/playbooks';
import {
  CrmWfComplianceFactsService,
  humanOwns,
  pickChannel,
} from './compliance-facts.service';
import { CrmWfControlService } from './control.service';
import {
  AgentKey,
  CRM_WORKFORCE_FLAG,
  WorkflowKey,
} from './crm-workforce.types';
import { CrmWfFactsService } from './facts.service';
import { leadFacts } from './intake.service';
import { prioritize } from './intelligence/prioritization';
import { evaluateCompliance } from './policy/compliance.engine';
import { escalationFor, standingOptOuts } from './policy/inbound-signals';
import { CrmWfQueueService } from './queue.service';
import { CrmWfSuppressionService } from './suppression.service';
import { auditSafe, CrmWfVaultService } from './vault.service';
import { CrmWfActionService } from './action.service';
import { CrmWfWorkItemService } from './work-item.service';

export type ProcessOutcome =
  | 'flag_off'
  | 'deferred_halted'
  | 'superseded'
  | 'human_active'
  | 'suppressed'
  | 'escalated'
  | 'observed'
  | 'consent_review'
  | 'not_contactable'
  | 'drafted'
  | 'sent_autonomously'
  | 'budget_deferred'
  | 'draft_blocked'
  | 'lost_claim'
  | 'lock_busy';

/**
 * BDC Supervisor. Coordinates every agent and is the only thing that turns a queued task into
 * an action record. Order matters and is fixed:
 *   lock → tenant/rooftop check → feature flag → kill switches → still-current? → human owner →
 *   stop/escalate signals → operating mode → compliance → draft → guard → action record.
 * Agents (playbooks + model) only ever write text inside the box this leaves them; they cannot
 * change a permission, a mode, a policy or another lead.
 */
@Injectable()
export class CrmWfSupervisorService {
  private readonly logger = new Logger('CrmWfSupervisor');
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: CrmWfQueueService,
    private readonly controls: CrmWfControlService,
    private readonly flags: FeatureFlagsService,
    private readonly lock: TurnLockService,
    private readonly facts: CrmWfFactsService,
    private readonly complianceFacts: CrmWfComplianceFactsService,
    private readonly drafter: CrmWfDrafterService,
    private readonly suppression: CrmWfSuppressionService,
    private readonly vault: CrmWfVaultService,
    private readonly items: CrmWfWorkItemService,
    private readonly actions: CrmWfActionService,
  ) {}

  async process(task: CrmWfTask, now = new Date()): Promise<ProcessOutcome> {
    try {
      return await this.lock.run(
        `${task.tenantId}:crmwf:${task.crmLeadId}`,
        () => this.locked(task, now),
        { waitMs: 2_000, ttlMs: 60_000 },
      );
    } catch (e) {
      if ((e as { status?: number })?.status === 409) {
        await this.queue.defer(
          task.id,
          new Date(Date.now() + 15_000),
          'conversation_lock_busy',
        );
        return 'lock_busy';
      }
      throw e;
    }
  }

  private async locked(task: CrmWfTask, now: Date): Promise<ProcessOutcome> {
    if (!(await this.queue.beginHandling(task.id))) return 'lost_claim';
    const finish = async (
      status: Parameters<CrmWfQueueService['finish']>[1],
      reason: string,
      outcome: ProcessOutcome,
    ) => {
      await this.queue.finish(task.id, status, reason);
      return outcome;
    };

    const leadRow = await this.prisma.crmWfLead.findFirst({
      // Tenant AND rooftop are part of the lookup: a task can never resolve another store's lead.
      where: {
        id: task.crmLeadId,
        tenantId: task.tenantId,
        locationId: task.locationId,
      },
      include: { messages: true },
    });
    const lead = leadRow ? this.vault.withMessages(leadRow) : null;
    if (!lead)
      return finish('CANCELLED', 'lead_not_in_task_rooftop', 'superseded');

    const flags = await this.flags.resolve(task.tenantId, task.locationId);
    if (!flags[CRM_WORKFORCE_FLAG])
      return finish('BLOCKED', 'feature_flag_off', 'flag_off');

    const workflowKey = task.workflowKey as WorkflowKey;
    const control = await this.controls.effective({
      tenantId: lead.tenantId,
      locationId: lead.locationId,
      department: lead.department,
      workflowKey,
      assignedTo: lead.assignedTo,
    });
    if (control.halted) {
      await this.queue.defer(
        task.id,
        new Date(now.getTime() + 5 * 60_000),
        `halted:${control.haltedBy.join(',')}`,
      );
      return 'deferred_halted';
    }

    // Is this task still what the lead needs? (The customer may have replied, booked, or left.)
    const { facts: lf, signals } = leadFacts(lead, lead.messages);
    const current = prioritize(lf, now);
    if (!current || current.workflowKey !== workflowKey)
      return finish('CANCELLED', 'no_longer_applicable', 'superseded');

    if (lead.agentPaused)
      return finish(
        'SUPPRESSED',
        `lead_paused:${lead.pausedReason ?? ''}`,
        'human_active',
      );
    if (humanOwns(lead, lead.messages, now))
      return finish('SUPPRESSED', 'human_conversation_active', 'human_active');

    const optOuts = standingOptOuts(
      lead.messages.filter(
        (m) => m.direction === 'INBOUND' && m.authorType === 'CUSTOMER',
      ),
    );
    if (optOuts.length) {
      for (const o of optOuts)
        await this.suppression.suppressLead({
          tenantId: lead.tenantId,
          crmLeadId: lead.id,
          scope: o.channelScope,
          channel: o.channel,
          reason: o.reason,
          source: 'INBOUND_MESSAGE',
        });
      await this.queue.finish(
        task.id,
        'SUPPRESSED',
        `customer_${optOuts[0].reason.toLowerCase()}`,
      );
      return 'suppressed';
    }

    const esc = escalationFor(signals);
    if (esc) {
      await this.escalate(
        task,
        lead.id,
        `customer_${esc.reason.toLowerCase()}`,
        esc.urgency,
        { signals },
      );
      return 'escalated';
    }
    // Sales-team assistance: tell the owner about a ready buyer or an appointment change
    // right away. These are internal work items — nothing is sent to the customer by them.
    const version = (lead.contentHash ?? '').slice(0, 16);
    if (signals.includes('PURCHASE_INTENT')) {
      await this.items.create({
        tenantId: lead.tenantId,
        locationId: lead.locationId,
        crmLeadId: lead.id,
        department: lead.department,
        kind: 'QUALIFIED_BUYER',
        urgency: 'HIGH',
        title: 'Customer shows immediate purchase intent',
        assigneeName: lead.assignedTo,
        createdBy: `agent:${task.agentKey}`,
        payload: {
          signals,
          recommendedNextAction: 'Call or reply now; offer a visit time.',
        },
        dedupeKey: `QUALIFIED_BUYER:${lead.id}:${version}`,
      });
      await this.prisma.crmWfOutcome.createMany({
        skipDuplicates: true,
        data: [
          {
            tenantId: lead.tenantId,
            locationId: lead.locationId,
            crmLeadId: lead.id,
            department: lead.department,
            kind: 'QUALIFIED',
            basis: 'OBSERVED',
            sourceRecordId: `intent:${version}`,
            verified: lead.verified,
            occurredAt: now,
          },
        ],
      });
    }
    if (signals.includes('APPOINTMENT_CHANGE'))
      await this.items.create({
        tenantId: lead.tenantId,
        locationId: lead.locationId,
        crmLeadId: lead.id,
        department: lead.department,
        kind: 'APPOINTMENT_RESCHEDULE',
        urgency: 'HIGH',
        title: 'Customer asked to change or cancel their appointment',
        dueAt: lead.appointmentAt,
        assigneeName: lead.assignedTo,
        createdBy: `agent:${task.agentKey}`,
        payload: {
          crmAppointmentAt: lead.appointmentAt?.toISOString() ?? null,
          availability:
            'NOT_VERIFIED — an employee updates the appointment in the CRM',
        },
        dedupeKey: `APPOINTMENT_RESCHEDULE:${lead.id}:${version}`,
      });

    if (signals.includes('PROMPT_INJECTION'))
      await this.audit(task, 'crmwf.security.prompt_injection_detected', {
        leadId: lead.id,
      });

    // OBSERVE: analysis only. No model call, no draft, no write of any kind.
    if (control.mode === 'OBSERVE')
      return finish('DONE', 'observed_only', 'observed');

    const channel = pickChannel(lead, lead.messages);
    if (!channel)
      return finish('BLOCKED', 'no_contact_endpoint', 'not_contactable');

    const input = await this.complianceFacts.gather(
      lead,
      lead.messages,
      workflowKey,
      channel,
      now,
    );
    const decision = evaluateCompliance(input);
    if (!decision.draftAllowed) {
      await this.audit(task, 'crmwf.compliance.blocked', {
        leadId: lead.id,
        rules: decision.blocks.map((b) => b.rule),
      });
      return decision.routeForReview
        ? finish('BLOCKED', 'consent_review_required', 'consent_review')
        : finish(
            'SUPPRESSED',
            `compliance:${decision.blocks.map((b) => (b.rule === 'control' ? `control:${b.detail}` : b.rule)).join(',')}`.slice(
              0,
              280,
            ),
            'not_contactable',
          );
    }

    const dealership = await this.facts.dealership(
      lead.tenantId,
      lead.locationId,
    );
    const profile = await this.prisma.crmWfAgentProfile.findUnique({
      where: {
        tenantId_locationId_department: {
          tenantId: lead.tenantId,
          locationId: lead.locationId,
          department: lead.department,
        },
      },
    });
    const proposed = PROPOSED_IDENTITIES[dealership?.tenantSlug ?? ''] ?? {
      displayName: 'the virtual assistant',
      title: 'Virtual BDC Manager',
    };
    const identity = profile
      ? {
          displayName: profile.displayName,
          title: profile.title,
          disclosure: profile.disclosure,
        }
      : {
          ...proposed,
          disclosure: defaultDisclosure(
            proposed.displayName,
            proposed.title,
            dealership?.name ?? 'the dealership',
          ),
        };
    const { facts, appointmentConfirmed, guidance } = await this.facts.forLead(
      lead,
      now,
    );

    const draft = await this.drafter.draft({
      guidance,
      lead,
      messages: lead.messages,
      agent: task.agentKey as AgentKey,
      workflow: workflowKey,
      channel,
      facts,
      appointmentConfirmed,
      identity,
      dealershipName: dealership?.name ?? 'the dealership',
      taskId: task.id,
      // ASSIST: an employee sends it as themselves. Otherwise the virtual representative does.
      sender: control.mode === 'ASSIST' ? 'EMPLOYEE' : 'VIRTUAL',
    });
    if (!draft.ok) {
      if (draft.reason.startsWith('budget_exhausted')) {
        // Spending limit reached: wait for tomorrow. Not an error, not charged as an attempt.
        const tomorrow = new Date(
          Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate() + 1,
            0,
            5,
          ),
        );
        await this.queue.defer(task.id, tomorrow, draft.reason);
        return 'budget_deferred';
      }
      if (draft.reason.startsWith('model_unavailable')) {
        // Provider outage / spend cap: retry later with backoff; nothing is sent meanwhile.
        const dead = await this.queue.fail(
          task.id,
          draft.reason,
          task.attempts,
        );
        if (dead)
          await this.audit(task, 'crmwf.task.dead', { reason: draft.reason });
        return 'draft_blocked';
      }
      await this.escalate(
        task,
        lead.id,
        'draft_failed_quality_guard',
        'NORMAL',
        { violations: draft.violations?.map((v) => v.rule) },
      );
      return 'escalated';
    }

    // ASSIST → a recommendation for an employee. SUPERVISED / CONTROLLED_AUTONOMOUS → waits for
    // approval. Auto-approval is decided by the action service at execution time, never here.
    // Level 3: inside a complete, unexpired workflow permit — and only when every compliance
    // rule already passes — the action is created approved-by-policy. The action service
    // re-checks everything, plus the permit's own channel, window and volume limits.
    const autonomous =
      control.mode === 'CONTROLLED_AUTONOMOUS' && decision.sendAllowed;
    const status =
      control.mode === 'ASSIST'
        ? 'DRAFT'
        : autonomous
          ? 'APPROVED'
          : 'PENDING_APPROVAL';
    const idempotencyKey = `msg:${task.dedupeKey}`;
    await this.prisma.$transaction(async (tx) => {
      const exists = await tx.crmWfAction.findUnique({
        where: {
          tenantId_idempotencyKey: { tenantId: lead.tenantId, idempotencyKey },
        },
      });
      if (!exists)
        await tx.crmWfAction.create({
          data: {
            tenantId: lead.tenantId,
            locationId: lead.locationId,
            crmLeadId: lead.id,
            taskId: task.id,
            department: lead.department,
            actionType:
              channel === 'SMS' ? 'message.sms.send' : 'message.email.send',
            sideEffect: 'EXTERNAL',
            adapterKey: lead.adapterKey,
            channel,
            payload: {
              body: draft.text,
              agent: task.agentKey,
              workflow: workflowKey,
              identity: identity.displayName,
              facts: facts.map((f) => ({
                kind: f.kind,
                sourceRecordId: f.sourceRecordId,
                asOf: f.asOf,
              })),
              playbookChecksum: playbookChecksum(draft.playbook),
              guardAttempts: draft.attempts,
            },
            status,
            complianceDecision: decision as object,
            idempotencyKey,
            playbookKey: draft.playbook.key,
            playbookVersion: draft.playbook.version,
          },
        });
      await tx.auditLog.create({
        data: {
          tenantId: lead.tenantId,
          action: 'crmwf.action.drafted',
          resource: 'CrmWfLead',
          resourceId: lead.id,
          metadata: auditSafe({
            taskId: task.id,
            workflowKey,
            channel,
            mode: control.mode,
            sendAllowed: decision.sendAllowed,
          }),
        },
      });
    });
    await this.queue.finish(
      task.id,
      'AWAITING_APPROVAL',
      control.mode === 'ASSIST'
        ? 'draft_for_employee'
        : autonomous
          ? 'sending_within_permit'
          : 'awaiting_manager_approval',
    );
    if (autonomous) {
      const a = await this.prisma.crmWfAction.findUnique({
        where: {
          tenantId_idempotencyKey: { tenantId: lead.tenantId, idempotencyKey },
        },
      });
      // The conversation lock is already held by this task.
      if (a) await this.actions.executeAfterLock(a.id);
      return 'sent_autonomously';
    }
    return 'drafted';
  }

  /** Hand to a person: pause the lead so nothing autonomous follows, and record why. */
  private async escalate(
    task: CrmWfTask,
    leadId: string,
    reason: string,
    urgency: string,
    detail: object,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await tx.crmWfLead.update({
        where: { id: leadId },
        data: {
          agentPaused: true,
          pausedReason: `escalated:${reason}`,
          pausedByUserId: null,
        },
      });
      await tx.crmWfAction.updateMany({
        where: {
          tenantId: task.tenantId,
          crmLeadId: leadId,
          status: { in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'QUEUED'] },
        },
        data: { status: 'CANCELLED', statusReason: `escalated:${reason}` },
      });
      await tx.auditLog.create({
        data: {
          tenantId: task.tenantId,
          action: 'crmwf.escalated',
          resource: 'CrmWfLead',
          resourceId: leadId,
          metadata: auditSafe({ taskId: task.id, reason, urgency, ...detail }),
        },
      });
    });
    // Department-specific escalation: an internal item for the owner / department lead.
    const level =
      (['LOW', 'NORMAL', 'HIGH', 'CRITICAL'] as const).find(
        (u) => u === urgency,
      ) ?? 'NORMAL';
    await this.items.create({
      tenantId: task.tenantId,
      locationId: task.locationId,
      crmLeadId: leadId,
      department: task.department,
      kind: 'ESCALATION',
      urgency: level,
      title: `Customer needs a person: ${reason.replace(/^customer_/, '').replace(/_/g, ' ')}`,
      createdBy: `agent:${task.agentKey}`,
      payload: { reason, ...detail },
      dedupeKey: `ESCALATION:${leadId}:${task.id}`,
    });
    await this.queue.finish(task.id, 'ESCALATED', `${urgency}:${reason}`);
  }

  private audit(task: CrmWfTask, action: string, metadata: object) {
    return this.prisma.auditLog.create({
      data: {
        tenantId: task.tenantId,
        action,
        resource: 'CrmWfTask',
        resourceId: task.id,
        metadata,
      },
    });
  }
}
