import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { TurnLockService } from '../chat/turn-lock.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { PrismaService } from '../prisma/prisma.service';
import { CrmWfDrafterService } from './agents/drafter.service';
import { playbookChecksum } from './agents/playbooks';
import {
  CrmWfComplianceFactsService,
  pickChannel,
} from './compliance-facts.service';
import { Actor, CrmWfControlService } from './control.service';
import {
  AgentKey,
  Channel,
  CRM_WORKFORCE_FLAG,
  Department,
  WorkflowKey,
} from './crm-workforce.types';
import { CrmWfFactsService } from './facts.service';
import { CrmWfIntakeService, leadFacts } from './intake.service';
import { prioritize } from './intelligence/prioritization';
import { evaluateCompliance } from './policy/compliance.engine';
import { escalationFor, standingOptOuts } from './policy/inbound-signals';
import { CrmWfSuppressionService } from './suppression.service';
import { auditSafe, CrmWfVaultService } from './vault.service';
import { CrmWfWorkItemService } from './work-item.service';

type Scope = { tenantId: string; locationId: string | null };
const DEPT_AGENT: Record<Department, AgentKey> = {
  SALES: 'sales_bdc',
  SERVICE: 'service_bdc',
  PARTS: 'parts_bdc',
};
/** Rules that mean "do not write to this customer at all", even for an employee to send. */
const HARD = new Set([
  'suppressed',
  'opted_out',
  'crm_do_not_contact',
  'lead_paused',
  'halted',
]);

/**
 * Mode A — employee-assisted CRM operations.
 *
 * An authorized employee stays the one who acts in the CRM. They pick a lead (or enter the
 * minimum context for one), get a draft written for them to send under their own name, send it
 * in the CRM themselves, and record what happened. Nothing here reads the CRM or clicks in it.
 *
 * What the employee is told, every time: any consent, hours or policy gap the system can see
 * (as warnings — the employee is the responsible sender), and a hard refusal when the customer
 * opted out, is marked do-not-contact, or the lead is paused.
 */
@Injectable()
export class CrmWfAssistService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: FeatureFlagsService,
    private readonly controls: CrmWfControlService,
    private readonly intake: CrmWfIntakeService,
    private readonly vault: CrmWfVaultService,
    private readonly facts: CrmWfFactsService,
    private readonly complianceFacts: CrmWfComplianceFactsService,
    private readonly drafter: CrmWfDrafterService,
    private readonly suppression: CrmWfSuppressionService,
    private readonly items: CrmWfWorkItemService,
    private readonly lock: TurnLockService,
  ) {}

  private async enabled(tenantId: string, locationId: string) {
    const f = await this.flags.resolve(tenantId, locationId);
    if (!f[CRM_WORKFORCE_FLAG])
      throw new ForbiddenException(
        'crm_workforce_not_enabled_for_this_rooftop',
      );
    const c = await this.prisma.crmWfConnector.findUnique({
      where: {
        tenantId_locationId_adapterKey: {
          tenantId,
          locationId,
          adapterKey: 'manual_assist',
        },
      },
    });
    return !!c?.enabled;
  }

  /** Enter a lead by hand with the minimum context. No phone or email is needed or stored. */
  async createLead(
    actor: Actor,
    scope: { tenantId: string; locationId: string },
    p: {
      crmRecordId?: string;
      firstName?: string;
      department: Department;
      vehicle?: { year?: number; make?: string; model?: string };
      assignedTo?: string;
      leadSource?: string;
      customerMessage?: string;
      channel?: Channel;
    },
  ) {
    if (!(await this.enabled(scope.tenantId, scope.locationId)))
      throw new ForbiddenException(
        'employee_assisted_connection_is_not_switched_on_for_this_rooftop',
      );
    const id = p.crmRecordId?.trim() || `MAN-${randomBytes(6).toString('hex')}`;
    const now = new Date().toISOString();
    await this.intake.ingest(scope, 'manual_assist', [
      {
        sourceRecordId: id,
        asOf: now,
        verified: false,
        synthetic: false,
        department: p.department,
        firstName: p.firstName?.trim().slice(0, 40) || null,
        leadSource: p.leadSource?.trim().slice(0, 80) || 'Entered by employee',
        crmStatus: 'Active',
        assignedTo: p.assignedTo?.trim().slice(0, 80) || null,
        vehicleInterest: p.vehicle?.make || p.vehicle?.model ? p.vehicle : null,
        createdInCrmAt: now,
        doNotContact: null,
        messages: p.customerMessage?.trim()
          ? [
              {
                sourceRecordId: `${id}:m:${Date.now()}`,
                direction: 'INBOUND',
                channel: p.channel ?? 'SMS',
                authorType: 'CUSTOMER',
                body: p.customerMessage.trim().slice(0, 2000),
                occurredAt: now,
              },
            ]
          : [],
      },
    ]);
    const lead = await this.prisma.crmWfLead.findUniqueOrThrow({
      where: {
        tenantId_adapterKey_sourceRecordId: {
          tenantId: scope.tenantId,
          adapterKey: 'manual_assist',
          sourceRecordId: id,
        },
      },
    });
    await this.prisma.auditLog.create({
      data: {
        tenantId: scope.tenantId,
        userId: actor.userId,
        action: 'crmwf.assist.lead_entered',
        resource: 'CrmWfLead',
        resourceId: lead.id,
        metadata: { department: p.department, hasMessage: !!p.customerMessage },
      },
    });
    return { id: lead.id, crmRecordId: id };
  }

  /** Record what the customer (or the employee) said, so the next draft has the full thread. */
  async addMessage(
    actor: Actor,
    scope: Scope,
    leadId: string,
    p: { direction: 'INBOUND' | 'OUTBOUND'; text: string; channel?: Channel },
  ) {
    const lead = await this.prisma.crmWfLead.findFirst({
      where: {
        id: leadId,
        tenantId: scope.tenantId,
        ...(scope.locationId ? { locationId: scope.locationId } : {}),
      },
    });
    if (!lead) throw new NotFoundException('lead_not_found');
    const text = p.text.trim().slice(0, 2000);
    if (!text) throw new BadRequestException('message_text_required');
    const at = new Date();
    const sourceRecordId = `staff:${actor.userId}:${at.getTime()}`;
    await this.prisma.$transaction(async (tx) => {
      await tx.crmWfMessage.create({
        data: {
          tenantId: lead.tenantId,
          crmLeadId: lead.id,
          direction: p.direction,
          channel: p.channel ?? 'SMS',
          authorType: p.direction === 'INBOUND' ? 'CUSTOMER' : 'STAFF',
          bodyEnc: this.vault.seal(text) ?? '',
          sourceRecordId,
          occurredAt: at,
        },
      });
      await tx.crmWfLead.update({
        where: { id: lead.id },
        data: {
          ...(p.direction === 'INBOUND'
            ? { lastInboundAt: at }
            : { lastOutboundAt: at }),
          // New content → new version, so the lead is re-planned and re-drafted once, not twice.
          contentHash: createHash('sha256')
            .update(`${lead.contentHash ?? ''}|${sourceRecordId}`)
            .digest('hex'),
        },
      });
    });
    await this.intake.plan(lead.id);
    return { ok: true };
  }

  /** Write a reply for the employee to send as themselves. Synchronous, one model call. */
  async draft(
    actor: Actor,
    scope: Scope,
    leadId: string,
    p: { staffNote?: string; channel?: Channel } = {},
  ) {
    const row = await this.prisma.crmWfLead.findFirst({
      where: {
        id: leadId,
        tenantId: scope.tenantId,
        ...(scope.locationId ? { locationId: scope.locationId } : {}),
      },
      select: { id: true, tenantId: true, locationId: true },
    });
    if (!row) throw new NotFoundException('lead_not_found');
    const f = await this.flags.resolve(row.tenantId, row.locationId);
    if (!f[CRM_WORKFORCE_FLAG])
      throw new ForbiddenException(
        'crm_workforce_not_enabled_for_this_rooftop',
      );
    return this.lock.run(
      `${row.tenantId}:crmwf:${row.id}`,
      () => this.draftLocked(actor, row.id, p),
      { waitMs: 5_000, ttlMs: 60_000 },
    );
  }

  private async draftLocked(
    actor: Actor,
    leadId: string,
    p: { staffNote?: string; channel?: Channel },
  ) {
    const now = new Date();
    const lead = this.vault.withMessages(
      await this.prisma.crmWfLead.findUniqueOrThrow({
        where: { id: leadId },
        include: { messages: true },
      }),
    );
    const { facts: lf, signals } = leadFacts(lead, lead.messages);
    const current = prioritize(lf, now);
    const workflow: WorkflowKey =
      current?.workflowKey ??
      (lead.lastInboundAt ? 'reply_inbound' : 'first_response');
    const agent: AgentKey = current?.agentKey ?? DEPT_AGENT[lead.department];

    const control = await this.controls.effective({
      tenantId: lead.tenantId,
      locationId: lead.locationId,
      department: lead.department,
      workflowKey: workflow,
      assignedTo: lead.assignedTo,
    });
    if (control.halted)
      throw new ConflictException(`stopped:${control.haltedBy.join(',')}`);
    if (control.mode === 'OBSERVE')
      throw new ConflictException('rooftop_is_in_observe_mode_drafting_is_off');

    // The customer said stop: record it and refuse. No draft is written.
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
      return {
        kind: 'suppressed' as const,
        reason: optOuts[0].reason,
        message:
          'The customer asked not to be contacted. No reply was written; update the CRM preference.',
      };
    }

    const channel = p.channel ?? pickChannel(lead, lead.messages) ?? 'SMS';
    const decision = evaluateCompliance(
      await this.complianceFacts.gather(
        lead,
        lead.messages,
        workflow,
        channel,
        now,
      ),
    );
    const hard = decision.blocks.filter((b) => HARD.has(b.rule));
    if (hard.length)
      return {
        kind: 'blocked' as const,
        blocks: hard,
        message: 'This customer cannot be contacted right now.',
      };

    const recommendation = await this.items.recommendAssignee(
      lead.tenantId,
      lead.locationId,
      lead.assignedTo,
    );
    const esc = escalationFor(signals);
    if (esc) {
      const item = await this.items.create({
        tenantId: lead.tenantId,
        locationId: lead.locationId,
        crmLeadId: lead.id,
        department: lead.department,
        kind: 'ESCALATION',
        urgency: esc.urgency,
        title: `Customer needs a person: ${esc.reason.toLowerCase().replace(/_/g, ' ')}`,
        assigneeName: lead.assignedTo,
        createdBy: `user:${actor.userId}`,
        payload: { reason: esc.reason, signals },
        dedupeKey: `ESCALATION:${lead.id}:${(lead.contentHash ?? '').slice(0, 16)}`,
      });
      return {
        kind: 'handoff' as const,
        reason: esc.reason,
        urgency: esc.urgency,
        workItemId: item.id,
        recommendation,
        message: 'This needs a person to decide. No reply was written.',
      };
    }

    const dealership = await this.facts.dealership(
      lead.tenantId,
      lead.locationId,
    );
    const { facts, appointmentConfirmed } = await this.facts.forLead(lead, now);
    const draft = await this.drafter.draft({
      lead,
      messages: lead.messages,
      agent,
      workflow,
      channel,
      facts,
      appointmentConfirmed,
      sender: 'EMPLOYEE',
      staffNote: p.staffNote,
      identity: { displayName: 'the team', title: '', disclosure: '' },
      dealershipName: dealership?.name ?? 'the dealership',
    });
    if (!draft.ok) {
      if (draft.reason.startsWith('budget_exhausted'))
        throw new ConflictException(draft.reason);
      if (draft.reason.startsWith('model_unavailable'))
        throw new ConflictException('writing_service_unavailable_try_again');
      return {
        kind: 'no_draft' as const,
        reason: draft.reason,
        violations: draft.violations?.map((v) => v.rule) ?? [],
        recommendation,
        message:
          'A safe reply could not be written. Reply to this customer yourself.',
      };
    }
    const n = await this.prisma.crmWfAction.count({
      where: { tenantId: lead.tenantId, crmLeadId: lead.id },
    });
    // A new request supersedes any earlier unsent draft for this customer.
    await this.prisma.crmWfAction.updateMany({
      where: { tenantId: lead.tenantId, crmLeadId: lead.id, status: 'DRAFT' },
      data: { status: 'CANCELLED', statusReason: 'replaced_by_newer_draft' },
    });
    const action = await this.prisma.crmWfAction.create({
      data: {
        tenantId: lead.tenantId,
        locationId: lead.locationId,
        crmLeadId: lead.id,
        department: lead.department,
        actionType:
          channel === 'SMS' ? 'message.sms.send' : 'message.email.send',
        sideEffect: 'EXTERNAL',
        adapterKey: lead.adapterKey,
        channel,
        payload: {
          body: draft.text,
          agent,
          workflow,
          sender: 'EMPLOYEE',
          requestedByUserId: actor.userId,
          facts: facts.map((x) => ({
            kind: x.kind,
            sourceRecordId: x.sourceRecordId,
            asOf: x.asOf,
          })),
          playbookChecksum: playbookChecksum(draft.playbook),
          guardAttempts: draft.attempts,
        },
        status: 'DRAFT',
        complianceDecision: decision as object,
        idempotencyKey: `assist:${lead.id}:${n + 1}:${(lead.contentHash ?? '').slice(0, 12)}`,
        playbookKey: draft.playbook.key,
        playbookVersion: draft.playbook.version,
      },
    });
    await this.prisma.auditLog.create({
      data: {
        tenantId: lead.tenantId,
        userId: actor.userId,
        action: 'crmwf.assist.drafted',
        resource: 'CrmWfLead',
        resourceId: lead.id,
        metadata: auditSafe({
          actionId: action.id,
          workflow,
          channel,
          warnings: decision.blocks.map((b) => b.rule),
        }),
      },
    });
    return {
      kind: 'draft' as const,
      actionId: action.id,
      text: draft.text,
      channel,
      workflow,
      // Not blocks: the employee is the sender. These are what the system could not confirm.
      warnings: decision.blocks.filter(
        (b) =>
          ![
            'control',
            'sender_identity_not_approved',
            'channel_capability_not_verified',
            'policy_not_legally_approved',
          ].includes(b.rule),
      ),
      facts: facts.map((x) => ({ kind: x.kind, text: x.text, asOf: x.asOf })),
      recommendation,
    };
  }
}
