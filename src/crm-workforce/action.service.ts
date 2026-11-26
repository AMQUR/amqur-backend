import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CrmWfAction, CrmWfActionStatus } from '@prisma/client';
import { TurnLockService } from '../chat/turn-lock.service';
import { PrismaService } from '../prisma/prisma.service';
import { CrmAdapterRegistry } from './adapters/adapter.registry';
import {
  AdapterBlockedError,
  CrmOperation,
  WriteRequest,
} from './adapters/crm-adapter';
import { guardDraft } from './agents/output-guard';
import { CrmWfComplianceFactsService } from './compliance-facts.service';
import { Actor } from './control.service';
import { Channel, WorkflowKey } from './crm-workforce.types';
import { CrmWfFactsService } from './facts.service';
import { evaluateCompliance, localMinutes } from './policy/compliance.engine';
import { hhmmToMin, isCompleteAuthorization } from './policy/controls';
import {
  auditSafe,
  CrmWfVaultService,
  STAFF_ENTERED_PREFIX,
} from './vault.service';

type Scope = { tenantId: string; locationId: string | null };

/**
 * External action pipeline. The rules that make "zero duplicate sends, zero unauthorized
 * writes" hold:
 *   - exactly one row per (tenant, idempotencyKey), and exactly one process can move it
 *     APPROVED → EXECUTING (a conditional UPDATE; the loser does nothing);
 *   - compliance is re-evaluated at execution time against CURRENT facts — a draft approved
 *     an hour ago is not sent to a customer who opted out a minute ago;
 *   - the adapter is called at most once per execution; its receipt is never the truth:
 *     only an independent read-back (verifyWrite) sets VERIFIED;
 *   - an unknown result is UNCERTAIN and is never retried blindly — reconcile() re-reads the
 *     CRM, and only a definite "not there" allows one retry with the SAME idempotency key.
 */
@Injectable()
export class CrmWfActionService {
  private readonly logger = new Logger('CrmWfAction');
  constructor(
    private readonly prisma: PrismaService,
    private readonly adapters: CrmAdapterRegistry,
    private readonly complianceFacts: CrmWfComplianceFactsService,
    private readonly facts: CrmWfFactsService,
    private readonly lock: TurnLockService,
    private readonly vault: CrmWfVaultService,
  ) {}

  private async load(scope: Scope, id: string) {
    const a = await this.prisma.crmWfAction.findFirst({
      where: {
        id,
        tenantId: scope.tenantId,
        ...(scope.locationId ? { locationId: scope.locationId } : {}),
      },
    });
    if (!a) throw new NotFoundException('action_not_found');
    return a;
  }

  private async move(
    id: string,
    from: CrmWfActionStatus[],
    data: Partial<CrmWfAction> & { status: CrmWfActionStatus },
  ) {
    const r = await this.prisma.crmWfAction.updateMany({
      where: { id, status: { in: from } },
      data: data as object,
    });
    return r.count === 1;
  }

  private audit(
    a: CrmWfAction,
    action: string,
    userId: string | null,
    metadata: object = {},
  ) {
    return this.prisma.auditLog.create({
      data: {
        tenantId: a.tenantId,
        userId,
        action,
        resource: 'CrmWfAction',
        resourceId: a.id,
        metadata: auditSafe({
          actionType: a.actionType,
          crmLeadId: a.crmLeadId,
          ...metadata,
        }),
      },
    });
  }

  /** Manager approval (SUPERVISED). An edited body is re-checked by the same guard. */
  async approve(actor: Actor, scope: Scope, id: string, editedBody?: string) {
    if (!['SUPER_ADMIN', 'ADMIN', 'MANAGER'].includes(actor.role))
      throw new ForbiddenException('approval_requires_manager');
    const a = await this.load(scope, id);
    if (a.status !== 'PENDING_APPROVAL')
      throw new ConflictException(`not_awaiting_approval:${a.status}`);
    let payload = a.payload as Record<string, unknown>;
    if (editedBody !== undefined && editedBody.trim() !== payload.body) {
      const leadRow = await this.prisma.crmWfLead.findFirst({
        where: { id: a.crmLeadId!, tenantId: a.tenantId },
        include: { messages: true },
      });
      if (!leadRow) throw new NotFoundException('lead_not_found');
      const lead = this.vault.withMessages(leadRow);
      const { facts, appointmentConfirmed } = await this.facts.forLead(lead);
      const prior = lead.messages
        .filter((m) => m.authorType === 'AGENT')
        .map((m) => m.body);
      const violations = guardDraft({
        text: editedBody,
        channel: a.channel as Channel,
        facts,
        priorAgentMessages: prior,
        agentDisplayName: String(payload.identity ?? ''),
        mustDisclose: prior.length === 0,
        appointmentConfirmed,
      });
      if (violations.length)
        throw new BadRequestException({
          message: 'edited_text_fails_guard',
          violations,
        });
      payload = {
        ...payload,
        body: editedBody.trim(),
        editedByUserId: actor.userId,
      };
    }
    const ok = await this.move(id, ['PENDING_APPROVAL'], {
      status: 'APPROVED',
      approvedByUserId: actor.userId,
      approvedAt: new Date(),
      payload: payload as never,
    });
    if (!ok) throw new ConflictException('already_decided');
    await this.audit(a, 'crmwf.action.approved', actor.userId, {
      edited: editedBody !== undefined,
    });
    return this.execute(id);
  }

  async reject(actor: Actor, scope: Scope, id: string, reason: string) {
    const a = await this.load(scope, id);
    const ok = await this.move(id, ['DRAFT', 'PENDING_APPROVAL'], {
      status: 'REJECTED',
      statusReason: reason.slice(0, 300),
    });
    if (!ok) throw new ConflictException(`cannot_reject:${a.status}`);
    await this.prisma.crmWfTask.updateMany({
      where: { id: a.taskId ?? '', status: 'AWAITING_APPROVAL' },
      data: { status: 'DONE', statusReason: 'draft_rejected' },
    });
    await this.audit(a, 'crmwf.action.rejected', actor.userId, { reason });
    return this.prisma.crmWfAction.findUnique({ where: { id } });
  }

  /** Employee-assisted: staff did it in the CRM themselves and says so. Never VERIFIED. */
  async staffConfirm(actor: Actor, scope: Scope, id: string, note?: string) {
    const a = await this.load(scope, id);
    const ok = await this.move(id, ['DRAFT', 'PENDING_APPROVAL'], {
      status: 'STAFF_CONFIRMED',
      statusReason: 'employee_sent_in_crm',
      approvedByUserId: actor.userId,
      approvedAt: new Date(),
      executedAt: new Date(),
      verification: {
        basis: 'staff_statement',
        byUserId: actor.userId,
        note: note?.slice(0, 300) ?? null,
      } as never,
    });
    if (!ok) throw new ConflictException(`cannot_confirm:${a.status}`);
    await this.afterContact(a, 'STAFF');
    await this.audit(a, 'crmwf.action.staff_confirmed', actor.userId);
    return this.prisma.crmWfAction.findUnique({ where: { id } });
  }

  /** Execute an APPROVED action. Safe to call concurrently and repeatedly. */
  async execute(id: string): Promise<CrmWfAction> {
    const pre = await this.prisma.crmWfAction.findUnique({ where: { id } });
    if (!pre) throw new NotFoundException('action_not_found');
    const run = () => this.executeLocked(id);
    return pre.crmLeadId
      ? this.lock.run(`${pre.tenantId}:crmwf:${pre.crmLeadId}`, run, {
          waitMs: 10_000,
          ttlMs: 60_000,
        })
      : run();
  }

  /** For callers that ALREADY hold the lead's conversation lock (the supervisor). */
  executeAfterLock(id: string): Promise<CrmWfAction> {
    return this.executeLocked(id);
  }

  private async executeLocked(id: string): Promise<CrmWfAction> {
    const current = () =>
      this.prisma.crmWfAction.findUniqueOrThrow({ where: { id } });
    // Single winner: only one caller ever moves APPROVED → EXECUTING.
    if (!(await this.move(id, ['APPROVED'], { status: 'EXECUTING' })))
      return current();
    const a = await current();
    const block = async (reason: string, decision?: object) => {
      await this.move(id, ['EXECUTING'], {
        status: 'BLOCKED',
        statusReason: reason.slice(0, 300),
        ...(decision ? { complianceDecision: decision as never } : {}),
      });
      await this.audit(a, 'crmwf.action.blocked', null, { reason });
      return current();
    };

    const leadRow = a.crmLeadId
      ? await this.prisma.crmWfLead.findFirst({
          where: {
            id: a.crmLeadId,
            tenantId: a.tenantId,
            locationId: a.locationId,
          },
          include: { messages: true },
        })
      : null;
    const lead = leadRow ? this.vault.withMessages(leadRow) : null;
    // Target verification: dealership, customer, channel, current state.
    if (!lead) return block('target_lead_not_in_action_rooftop');
    if (lead.adapterKey !== a.adapterKey) return block('adapter_mismatch');
    const adapter = this.adapters.get(a.adapterKey ?? '');
    if (!adapter) return block('adapter_unknown');
    const payload = a.payload as { body?: string; workflow?: string };
    if (a.actionType.startsWith('message.') && !payload.body?.trim())
      return block('empty_message');

    const now = new Date();
    const input = await this.complianceFacts.gather(
      lead,
      lead.messages,
      (payload.workflow ?? 'reply_inbound') as WorkflowKey,
      a.channel as Channel,
      now,
      a.id,
    );
    const decision = evaluateCompliance(input);
    if (!decision.sendAllowed)
      return block(
        `compliance:${decision.blocks.map((b) => (b.rule === 'control' ? `control:${b.detail}` : b.rule)).join(',')}`,
        decision,
      );
    // CONTROLLED_AUTONOMOUS may run without a person only inside its authorization; anything
    // else must carry a human approval.
    if (!a.approvedByUserId && input.control.mode !== 'CONTROLLED_AUTONOMOUS')
      return block('human_approval_required');
    if (!a.approvedByUserId) {
      // No person approved this: it must fit the workflow's recorded permit exactly.
      const permit = input.control.workflowAuthorization;
      if (!isCompleteAuthorization(permit, now))
        return block('permit_missing_or_expired');
      if (permit.department !== lead.department)
        return block('permit_department_mismatch');
      if (permit.operation !== a.actionType)
        return block('permit_operation_mismatch');
      if (!permit.channels.includes(a.channel ?? ''))
        return block('permit_channel_not_allowed');
      const loc = await this.prisma.location.findFirst({
        where: { id: a.locationId, tenantId: a.tenantId },
        select: { timezone: true },
      });
      const mins = localMinutes(now, loc?.timezone ?? 'America/Chicago');
      if (
        mins === null ||
        mins < hhmmToMin(permit.window.start) ||
        mins >= hhmmToMin(permit.window.end)
      )
        return block('permit_outside_operating_window');
      // The permit names the connection it may act through and the consent it relies on.
      if (permit.account !== a.adapterKey)
        return block('permit_account_mismatch');
      if (
        !input.consent.allowed ||
        (input.consent.purpose !== permit.consentRequired &&
          input.consent.purpose !== 'MARKETING')
      )
        return block('permit_consent_requirement_not_met');
      // A message an employee typed in is not CRM evidence: the system does not send on it
      // without a person's approval, and a hand-entered lead is never worked autonomously.
      const lastInbound = lead.messages
        .filter((m) => m.direction === 'INBOUND')
        .sort((x, y) => y.occurredAt.getTime() - x.occurredAt.getTime())[0];
      if (
        lead.adapterKey === 'manual_assist' ||
        lastInbound?.sourceRecordId.startsWith(STAFF_ENTERED_PREFIX)
      )
        return block('permit_requires_crm_sourced_conversation');
      // Volume limits are reserved atomically: one advisory lock per rooftop + workflow, and
      // actions that are mid-send count, so two workers cannot both take the last slot.
      const lockKey = `crmwf-permit:${a.locationId}:${payload.workflow ?? ''}`;
      const over = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
        const auto = {
          tenantId: a.tenantId,
          locationId: a.locationId,
          approvedByUserId: null,
          sideEffect: 'EXTERNAL' as const,
          id: { not: a.id },
          status: {
            in: [
              'EXECUTING',
              'SENT_UNVERIFIED',
              'UNCERTAIN',
              'VERIFIED',
            ] as CrmWfActionStatus[],
          },
          payload: { path: ['workflow'], equals: payload.workflow ?? '' },
        };
        const today = await tx.crmWfAction.count({
          where: {
            ...auto,
            updatedAt: { gte: new Date(now.getTime() - 86_400_000) },
          },
        });
        const thisCustomer = await tx.crmWfAction.count({
          where: {
            ...auto,
            crmLeadId: lead.id,
            updatedAt: { gte: new Date(now.getTime() - 7 * 86_400_000) },
          },
        });
        const reason =
          today >= permit.dailyLimit
            ? 'permit_daily_limit_reached'
            : thisCustomer >= permit.maxPerCustomerPerWeek
              ? 'permit_customer_weekly_limit_reached'
              : null;
        // Leaving EXECUTING inside the lock is what frees the slot for the next caller.
        if (reason)
          await tx.crmWfAction.updateMany({
            where: { id: a.id, status: 'EXECUTING' },
            data: { status: 'BLOCKED', statusReason: reason },
          });
        return reason;
      });
      if (over) {
        await this.audit(a, 'crmwf.action.blocked', null, { reason: over });
        return current();
      }
    }

    const req: WriteRequest = {
      tenantId: a.tenantId,
      locationId: a.locationId,
      operation: a.actionType as CrmOperation,
      leadSourceRecordId: lead.sourceRecordId,
      idempotencyKey: a.idempotencyKey,
      channel: a.channel as Channel,
      body: payload.body,
    };
    let receipt;
    try {
      receipt = await adapter.executeWrite(req);
    } catch (e) {
      if (e instanceof AdapterBlockedError)
        return block(`adapter_blocked:${e.reason}`, decision);
      // Thrown mid-call: we do not know whether the CRM received it.
      await this.move(id, ['EXECUTING'], {
        status: 'UNCERTAIN',
        statusReason: 'adapter_error_result_unknown',
        executedAt: now,
        complianceDecision: decision as never,
      });
      await this.audit(a, 'crmwf.action.uncertain', null, {
        cause: 'adapter_threw',
      });
      return current();
    }

    if (receipt.outcome === 'REJECTED') {
      await this.move(id, ['EXECUTING'], {
        status: 'FAILED',
        statusReason: receipt.detail.slice(0, 300),
        executedAt: now,
        complianceDecision: decision as never,
        verification: { receipt } as never,
      });
      await this.audit(a, 'crmwf.action.failed', null, {
        detail: receipt.detail,
      });
      return current();
    }
    if (receipt.outcome === 'UNCERTAIN') {
      await this.move(id, ['EXECUTING'], {
        status: 'UNCERTAIN',
        statusReason: receipt.detail.slice(0, 300),
        executedAt: now,
        complianceDecision: decision as never,
        verification: { receipt } as never,
      });
      await this.audit(a, 'crmwf.action.uncertain', null, {
        detail: receipt.detail,
      });
      return current();
    }
    // ACCEPTED is not "sent": record it as unverified, then read the CRM back.
    await this.move(id, ['EXECUTING'], {
      status: 'SENT_UNVERIFIED',
      executedAt: now,
      externalRef: receipt.externalRef,
      complianceDecision: decision as never,
      verification: { receipt } as never,
    });
    return this.verify(id, req);
  }

  private async verify(id: string, req: WriteRequest): Promise<CrmWfAction> {
    const a = await this.prisma.crmWfAction.findUniqueOrThrow({
      where: { id },
    });
    const adapter = this.adapters.get(a.adapterKey ?? '');
    const v = adapter
      ? await adapter
          .verifyWrite(req)
          .catch(() => ({ state: 'UNKNOWN' as const, detail: 'verify_threw' }))
      : { state: 'UNKNOWN' as const, detail: 'adapter_unknown' };
    const prior = (a.verification ?? {}) as object;
    if (v.state === 'VERIFIED') {
      const ok = await this.move(id, ['SENT_UNVERIFIED', 'UNCERTAIN'], {
        status: 'VERIFIED',
        verifiedAt: new Date(),
        externalRef: v.externalRef,
        statusReason: null,
        verification: { ...prior, readBack: v } as never,
      });
      if (ok) {
        await this.afterContact(a, 'AGENT');
        await this.audit(a, 'crmwf.action.verified', null, {
          externalRef: v.externalRef,
        });
      }
    } else {
      await this.move(id, ['SENT_UNVERIFIED'], {
        status: 'UNCERTAIN',
        statusReason:
          v.state === 'NOT_FOUND'
            ? 'accepted_but_not_found_on_read_back'
            : 'read_back_unavailable',
        verification: { ...prior, readBack: v } as never,
      });
      await this.audit(a, 'crmwf.action.uncertain', null, {
        readBack: v.state,
      });
    }
    return this.prisma.crmWfAction.findUniqueOrThrow({ where: { id } });
  }

  /**
   * Reconcile an UNCERTAIN action against the CRM before anything is retried.
   *   found      → VERIFIED (no resend)
   *   not found  → one retry with the SAME idempotency key (compliance re-checked again)
   *   unknown    → stays UNCERTAIN; a person decides
   */
  async reconcile(
    scope: Scope,
    id: string,
    opts: { allowRetry?: boolean } = {},
  ): Promise<CrmWfAction> {
    const a = await this.load(scope, id);
    if (a.status !== 'UNCERTAIN' && a.status !== 'SENT_UNVERIFIED') return a;
    const lead = await this.prisma.crmWfLead.findFirst({
      where: { id: a.crmLeadId ?? '', tenantId: a.tenantId },
    });
    const adapter = this.adapters.get(a.adapterKey ?? '');
    if (!lead || !adapter) return a;
    const payload = a.payload as { body?: string };
    const req: WriteRequest = {
      tenantId: a.tenantId,
      locationId: a.locationId,
      operation: a.actionType as CrmOperation,
      leadSourceRecordId: lead.sourceRecordId,
      idempotencyKey: a.idempotencyKey,
      channel: a.channel as Channel,
      body: payload.body,
    };
    const v = await adapter
      .verifyWrite(req)
      .catch(() => ({ state: 'UNKNOWN' as const, detail: 'verify_threw' }));
    const prior = (a.verification ?? {}) as { retries?: number };
    if (v.state === 'VERIFIED') {
      if (
        await this.move(id, ['UNCERTAIN', 'SENT_UNVERIFIED'], {
          status: 'VERIFIED',
          verifiedAt: new Date(),
          externalRef: v.externalRef,
          statusReason: 'verified_on_reconcile',
          verification: { ...prior, reconcile: v } as never,
        })
      ) {
        await this.afterContact(a, 'AGENT');
        await this.audit(a, 'crmwf.action.verified', null, {
          via: 'reconcile',
        });
      }
    } else if (
      v.state === 'NOT_FOUND' &&
      opts.allowRetry &&
      (prior.retries ?? 0) < 1
    ) {
      if (
        await this.move(id, ['UNCERTAIN', 'SENT_UNVERIFIED'], {
          status: 'APPROVED',
          statusReason: 'retry_after_reconcile_not_found',
          verification: {
            ...prior,
            reconcile: v,
            retries: (prior.retries ?? 0) + 1,
          } as never,
        })
      ) {
        await this.audit(a, 'crmwf.action.retry_after_reconcile', null);
        return this.execute(id);
      }
    } else {
      await this.prisma.crmWfAction.update({
        where: { id },
        data: { verification: { ...prior, reconcile: v } as never },
      });
    }
    return this.prisma.crmWfAction.findUniqueOrThrow({ where: { id } });
  }

  /** After real contact: record it in the conversation mirror and close the task. */
  private async afterContact(a: CrmWfAction, authorType: 'AGENT' | 'STAFF') {
    if (!a.crmLeadId || !a.actionType.startsWith('message.')) return;
    const body = String((a.payload as { body?: string }).body ?? '');
    const at = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.crmWfMessage.createMany({
        skipDuplicates: true,
        data: [
          {
            tenantId: a.tenantId,
            crmLeadId: a.crmLeadId!,
            direction: 'OUTBOUND',
            channel: a.channel ?? 'SMS',
            authorType,
            bodyEnc: this.vault.seal(body) ?? '',
            sourceRecordId: `crmwf:${a.id}`,
            occurredAt: at,
          },
        ],
      });
      await tx.crmWfLead.update({
        where: { id: a.crmLeadId! },
        data: { lastOutboundAt: at },
      });
      if (a.taskId)
        await tx.crmWfTask.updateMany({
          where: { id: a.taskId, status: 'AWAITING_APPROVAL' },
          data: {
            status: 'DONE',
            statusReason:
              authorType === 'AGENT' ? 'sent_verified' : 'sent_by_employee',
          },
        });
    });
  }
}
