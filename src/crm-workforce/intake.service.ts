import { Injectable } from '@nestjs/common';
import { CrmWfLead, CrmWfMessage } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AdapterScope, CrmLeadRecord } from './adapters/crm-adapter';
import {
  countUnanswered,
  LeadFacts,
  prioritize,
  PriorityResult,
} from './intelligence/prioritization';
import {
  InboundSignal,
  readInboundSignals,
  suppressionFor,
} from './policy/inbound-signals';
import { CrmWfQueueService } from './queue.service';
import { CrmWfSuppressionService } from './suppression.service';

const d = (s?: string | null) => (s ? new Date(s) : null);

export function leadContentHash(r: CrmLeadRecord): string {
  const { asOf: _asOf, messages, ...rest } = r;
  return createHash('sha256')
    .update(JSON.stringify(rest))
    .update(
      messages
        .map((m) => m.sourceRecordId)
        .sort()
        .join('|'),
    )
    .digest('hex');
}

/** Text of the customer's messages since our last outbound contact (newest last). */
export function unansweredInbound(
  messages: Array<
    Pick<CrmWfMessage, 'direction' | 'occurredAt' | 'body' | 'channel'>
  >,
): string[] {
  const sorted = [...messages].sort(
    (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
  );
  const out: string[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].direction !== 'INBOUND') break;
    out.unshift(sorted[i].body);
  }
  return out;
}

export function leadFacts(
  lead: CrmWfLead,
  messages: CrmWfMessage[],
  vehicleAvailableAgain: boolean | null = null,
): { facts: LeadFacts; signals: InboundSignal[] } {
  const signals = [
    ...new Set(unansweredInbound(messages).flatMap(readInboundSignals)),
  ];
  return {
    signals,
    facts: {
      department: lead.department,
      crmStatus: lead.crmStatus,
      leadSource: lead.leadSource,
      createdInCrmAt: lead.createdInCrmAt,
      lastInboundAt: lead.lastInboundAt,
      lastOutboundAt: lead.lastOutboundAt,
      hasFutureFollowUp: lead.hasFutureFollowUp,
      appointmentState: lead.appointmentState,
      appointmentAt: lead.appointmentAt,
      visitedAt: lead.visitedAt,
      inboundSignals: signals,
      unansweredAttempts: countUnanswered(messages),
      vehicleAvailableAgain,
    },
  };
}

export type IngestSummary = {
  received: number;
  created: number;
  updated: number;
  unchanged: number;
  tasksQueued: number;
  suppressed: number;
};

/**
 * Brings adapter records into the read mirror and plans work. One mirror row per
 * (tenant, adapter, CRM id), one conversation per customer and dealership. Unchanged records
 * are not re-analysed. Suppression signals are applied here, before anything is queued.
 */
@Injectable()
export class CrmWfIntakeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: CrmWfQueueService,
    private readonly suppression: CrmWfSuppressionService,
  ) {}

  async ingest(
    scope: AdapterScope,
    adapterKey: string,
    records: CrmLeadRecord[],
    now = new Date(),
  ): Promise<IngestSummary> {
    const s: IngestSummary = {
      received: records.length,
      created: 0,
      updated: 0,
      unchanged: 0,
      tasksQueued: 0,
      suppressed: 0,
    };
    for (const r of records) {
      const hash = leadContentHash(r);
      const key = {
        tenantId_adapterKey_sourceRecordId: {
          tenantId: scope.tenantId,
          adapterKey,
          sourceRecordId: r.sourceRecordId,
        },
      };
      const existing = await this.prisma.crmWfLead.findUnique({ where: key });
      // A mirror row never moves between rooftops: a record claiming another location is refused.
      if (existing && existing.locationId !== scope.locationId) continue;
      if (existing && existing.contentHash === hash) {
        s.unchanged += 1;
        await this.prisma.crmWfLead.update({
          where: { id: existing.id },
          data: { asOf: new Date(r.asOf) },
        });
        if (existing.lastProcessedHash !== hash)
          await this.plan(existing.id, now, s);
        continue;
      }
      const msgs = [...r.messages].sort(
        (a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt),
      );
      const lastIn = msgs.filter((m) => m.direction === 'INBOUND').at(-1);
      const lastOut = msgs
        .filter((m) => m.direction === 'OUTBOUND' && m.channel !== 'NOTE')
        .at(-1);
      const data = {
        asOf: new Date(r.asOf),
        verified: r.verified && !r.synthetic,
        synthetic: r.synthetic,
        department: r.department,
        firstName: r.firstName ?? null,
        lastName: r.lastName ?? null,
        phone: r.phone ?? null,
        email: r.email ?? null,
        language: r.language ?? null,
        leadSource: r.leadSource ?? null,
        crmStatus: r.crmStatus ?? null,
        assignedTo: r.assignedTo ?? null,
        vehicleInterest: (r.vehicleInterest ?? undefined) as object | undefined,
        createdInCrmAt: d(r.createdInCrmAt),
        lastInboundAt: d(lastIn?.occurredAt),
        lastOutboundAt: d(lastOut?.occurredAt),
        hasFutureFollowUp: !!r.hasFutureFollowUp,
        appointmentState: r.appointmentState ?? 'NONE',
        appointmentAt: d(r.appointmentAt),
        visitedAt: d(r.visitedAt),
        crmDoNotContact: r.doNotContact ?? null,
        humanActiveUntil: d(r.humanActiveUntil),
        contentHash: hash,
      };
      const lead = await this.prisma.$transaction(async (tx) => {
        const row = existing
          ? await tx.crmWfLead.update({ where: { id: existing.id }, data })
          : await tx.crmWfLead.create({
              data: {
                ...data,
                tenantId: scope.tenantId,
                locationId: scope.locationId,
                adapterKey,
                sourceRecordId: r.sourceRecordId,
              },
            });
        if (msgs.length)
          await tx.crmWfMessage.createMany({
            skipDuplicates: true,
            data: msgs.map((m) => ({
              tenantId: scope.tenantId,
              crmLeadId: row.id,
              direction: m.direction,
              channel: m.channel,
              authorType: m.authorType,
              body: m.body.slice(0, 4000),
              sourceRecordId: m.sourceRecordId,
              occurredAt: new Date(m.occurredAt),
            })),
          });
        return row;
      });
      if (existing) s.updated += 1;
      else s.created += 1;
      await this.recordObservedOutcomes(lead, r);
      await this.plan(lead.id, now, s);
    }
    return s;
  }

  /** Decide what, if anything, this lead needs — and queue exactly one task for it. */
  async plan(
    crmLeadId: string,
    now = new Date(),
    s?: IngestSummary,
  ): Promise<PriorityResult | null> {
    const lead = await this.prisma.crmWfLead.findUnique({
      where: { id: crmLeadId },
      include: { messages: true },
    });
    if (!lead) return null;
    const { facts, signals } = leadFacts(lead, lead.messages);
    const done = (extra: object = {}) =>
      this.prisma.crmWfLead.update({
        where: { id: lead.id },
        data: {
          lastProcessedHash: lead.contentHash,
          lastProcessedAt: now,
          ...extra,
        },
      });

    // The customer said stop (or the CRM says do-not-contact): suppress first, queue nothing.
    const sup = suppressionFor(signals);
    if (sup || lead.crmDoNotContact === true) {
      const lastInbound = [...lead.messages]
        .filter((m) => m.direction === 'INBOUND')
        .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())[0];
      await this.suppression.suppressLead({
        tenantId: lead.tenantId,
        crmLeadId: lead.id,
        scope: sup ? sup.channelScope : 'ALL',
        channel: lastInbound?.channel === 'EMAIL' ? 'EMAIL' : 'SMS',
        reason: sup ? sup.reason : 'DO_NOT_CONTACT',
        source: sup ? 'INBOUND_MESSAGE' : 'CRM_PREFERENCE',
      });
      if (sup)
        await this.outcome(
          lead,
          'OPT_OUT',
          `optout:${lead.contentHash?.slice(0, 16)}`,
          now,
        );
      if (s) s.suppressed += 1;
      await done();
      return null;
    }

    const result = prioritize(facts, now);
    if (!result) {
      await done();
      return null;
    }
    const dedupeKey = `${lead.id}:${result.workflowKey}:${(lead.contentHash ?? '').slice(0, 16)}`;
    await this.prisma.crmWfTask.updateMany({
      where: {
        tenantId: lead.tenantId,
        crmLeadId: lead.id,
        status: 'PENDING',
        dedupeKey: { not: dedupeKey },
      },
      data: {
        status: 'CANCELLED',
        statusReason: 'superseded_by_newer_lead_state',
      },
    });
    const { created } = await this.queue.enqueue({
      tenantId: lead.tenantId,
      locationId: lead.locationId,
      crmLeadId: lead.id,
      department: lead.department,
      agentKey: result.agentKey,
      workflowKey: result.workflowKey,
      priority: result.priority,
      evidence: {
        segment: result.segment,
        rules: result.evidence,
        signals,
      } as object,
      dedupeKey,
    });
    if (created && s) s.tasksQueued += 1;
    await done();
    return result;
  }

  private async recordObservedOutcomes(lead: CrmWfLead, r: CrmLeadRecord) {
    const at = new Date(r.asOf);
    if (r.appointmentState === 'SCHEDULED' && r.appointmentAt)
      await this.outcome(lead, 'APPT_SET', `appt:${r.appointmentAt}`, at);
    if (r.appointmentState === 'SHOWN' && r.appointmentAt)
      await this.outcome(lead, 'APPT_SHOWN', `appt:${r.appointmentAt}`, at);
    // A CRM deal/sold status is a deal record — not a verified sale or delivery.
    if (/^(sold|delivered)$/i.test(r.crmStatus ?? ''))
      await this.outcome(lead, 'DEAL_CREATED', `status:${r.crmStatus}`, at);
  }

  private async outcome(
    lead: CrmWfLead,
    kind: string,
    sourceRecordId: string,
    occurredAt: Date,
  ) {
    await this.prisma.crmWfOutcome.createMany({
      skipDuplicates: true,
      data: [
        {
          tenantId: lead.tenantId,
          locationId: lead.locationId,
          crmLeadId: lead.id,
          department: lead.department,
          kind,
          basis: 'OBSERVED',
          sourceRecordId,
          verified: lead.verified,
          occurredAt,
        },
      ],
    });
  }
}
