import { Injectable } from '@nestjs/common';
import { CrmWfLead, CrmWfMessage } from '@prisma/client';
import { isProductionTier } from '../config/deployment-tier';
import { ConsentService } from '../messaging/consent.service';
import { PrismaService } from '../prisma/prisma.service';
import { CrmAdapterRegistry } from './adapters/adapter.registry';
import { CrmOperation } from './adapters/crm-adapter';
import { CrmWfControlService } from './control.service';
import {
  Channel,
  MessagePurpose,
  WORKFLOW_PURPOSE,
  WorkflowKey,
} from './crm-workforce.types';
import { countUnanswered } from './intelligence/prioritization';
import {
  ComplianceInput,
  ConsentFact,
  timezoneForPhone,
} from './policy/compliance.engine';
import { CrmWfSuppressionService } from './suppression.service';

export const HUMAN_ACTIVE_WINDOW_MS = 30 * 60_000;
/** Statuses that may have reached the customer — all count toward caps (conservative). */
export const POSSIBLY_SENT = [
  'EXECUTING',
  'SENT_UNVERIFIED',
  'UNCERTAIN',
  'VERIFIED',
  'STAFF_CONFIRMED',
] as const;
export const OPEN_ACTION = [
  'PENDING_APPROVAL',
  'APPROVED',
  'QUEUED',
  'EXECUTING',
  'SENT_UNVERIFIED',
  'UNCERTAIN',
] as const;

export function pickChannel(
  lead: CrmWfLead,
  messages: CrmWfMessage[],
): Channel | null {
  const lastIn = [...messages]
    .filter((m) => m.direction === 'INBOUND')
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())[0];
  if (lastIn?.channel === 'EMAIL' && lead.email) return 'EMAIL';
  if (lastIn?.channel === 'SMS' && lead.phone) return 'SMS';
  if (lead.phone) return 'SMS';
  if (lead.email) return 'EMAIL';
  return null;
}

export function humanOwns(
  lead: CrmWfLead,
  messages: CrmWfMessage[],
  now: Date,
): boolean {
  if (lead.humanActiveUntil && lead.humanActiveUntil > now) return true;
  return messages.some(
    (m) =>
      m.authorType === 'STAFF' &&
      m.channel !== 'NOTE' &&
      now.getTime() - m.occurredAt.getTime() < HUMAN_ACTIVE_WINDOW_MS &&
      m.occurredAt <= now,
  );
}

/** Gathers the facts the pure compliance engine decides on. Reads only; decides nothing. */
@Injectable()
export class CrmWfComplianceFactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly consent: ConsentService,
    private readonly controls: CrmWfControlService,
    private readonly suppression: CrmWfSuppressionService,
    private readonly adapters: CrmAdapterRegistry,
  ) {}

  async gather(
    lead: CrmWfLead,
    messages: CrmWfMessage[],
    workflowKey: WorkflowKey,
    channel: Channel,
    now: Date,
    excludeActionId?: string,
  ): Promise<ComplianceInput> {
    const ep = CrmWfSuppressionService.endpointsOf(lead);
    const endpoint = channel === 'SMS' ? ep.sms : ep.email;
    const purpose = WORKFLOW_PURPOSE[workflowKey];
    const [control, policy, suppressions, loc, profile, connector] =
      await Promise.all([
        this.controls.effective({
          tenantId: lead.tenantId,
          locationId: lead.locationId,
          department: lead.department,
          workflowKey,
          assignedTo: lead.assignedTo,
        }),
        this.controls.policyFor(lead.tenantId),
        this.suppression.activeFor(lead.tenantId, ep.all),
        this.prisma.location.findFirst({
          where: { id: lead.locationId, tenantId: lead.tenantId },
          select: { timezone: true },
        }),
        this.prisma.crmWfAgentProfile.findUnique({
          where: {
            tenantId_locationId_department: {
              tenantId: lead.tenantId,
              locationId: lead.locationId,
              department: lead.department,
            },
          },
        }),
        this.prisma.crmWfConnector.findUnique({
          where: {
            tenantId_locationId_adapterKey: {
              tenantId: lead.tenantId,
              locationId: lead.locationId,
              adapterKey: lead.adapterKey,
            },
          },
        }),
      ]);

    let consent: ConsentFact = { allowed: false, reason: 'no_consent' };
    if (endpoint) {
      const st = await this.consent.status(
        lead.tenantId,
        channel,
        endpoint,
        purpose,
      );
      if (st.allowed && st.grantId) {
        const grant = await this.prisma.consentRecord.findFirst({
          where: { id: st.grantId, tenantId: lead.tenantId },
          select: { createdAt: true, purpose: true },
        });
        consent = grant
          ? {
              allowed: true,
              grantId: st.grantId as string,
              grantedAt: grant.createdAt.toISOString(),
              purpose: grant.purpose as MessagePurpose,
            }
          : { allowed: false, reason: 'no_consent' };
      } else
        consent = {
          allowed: false,
          reason: st.allowed ? 'no_consent' : st.reason,
        };
    } else consent = { allowed: false, reason: 'invalid_endpoint' };

    const dayAgo = new Date(now.getTime() - 86_400_000);
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
    const sent = (since: Date) =>
      Promise.all([
        this.prisma.crmWfAction.count({
          where: {
            tenantId: lead.tenantId,
            crmLeadId: lead.id,
            sideEffect: 'EXTERNAL',
            actionType: { startsWith: 'message.' },
            status: { in: [...POSSIBLY_SENT] },
            updatedAt: { gte: since },
          },
        }),
        // The platform's own outbound ledger: contact from any AMQUR workflow counts.
        endpoint
          ? this.prisma.outboundMessage.count({
              where: {
                tenantId: lead.tenantId,
                endpoint,
                status: { in: ['SENT', 'DELIVERED'] },
                createdAt: { gte: since },
              },
            })
          : Promise.resolve(0),
      ]).then(([a, b]) => a + b);
    const [sentToday, sentThisWeek, conflicting] = await Promise.all([
      sent(dayAgo),
      sent(weekAgo),
      this.prisma.crmWfAction.count({
        where: {
          tenantId: lead.tenantId,
          crmLeadId: lead.id,
          sideEffect: 'EXTERNAL',
          status: { in: [...OPEN_ACTION] },
          ...(excludeActionId ? { id: { not: excludeActionId } } : {}),
        },
      }),
    ]);

    const op: CrmOperation =
      channel === 'SMS' ? 'message.sms.send' : 'message.email.send';
    const cap = this.adapters.get(lead.adapterKey)?.capabilities()[op].status;
    const capOk =
      cap === 'LIVE VERIFIED' ||
      cap === 'SANDBOX VERIFIED' ||
      (cap === 'DEMO' && !isProductionTier());
    const phoneTz = timezoneForPhone(ep.sms);

    return {
      now,
      workflowKey,
      channel,
      endpoint,
      control,
      policy,
      consent,
      suppressions,
      crmDoNotContact: lead.crmDoNotContact,
      timezone: phoneTz ?? loc?.timezone ?? 'America/Chicago',
      timezoneSource: phoneTz ? 'customer' : 'dealership',
      sentToday,
      sentThisWeek,
      unansweredAttempts: countUnanswered(messages),
      lastInboundAt: lead.lastInboundAt,
      lastOutboundAt: lead.lastOutboundAt,
      humanOwnsConversation: humanOwns(lead, messages, now),
      leadPaused: lead.agentPaused,
      conflictingOpenAction: conflicting > 0,
      leadSource: lead.leadSource,
      senderIdentityApproved: !!profile?.active,
      channelCapabilityVerified:
        !!connector?.enabled &&
        (!this.adapters.get(lead.adapterKey)?.requiresAuthorization ||
          !!connector.authorizedAt) &&
        capOk,
    };
  }
}
