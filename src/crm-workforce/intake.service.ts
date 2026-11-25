import { Injectable } from '@nestjs/common';
import { CrmWfLead, Prisma } from '@prisma/client';
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
  standingOptOuts,
} from './policy/inbound-signals';
import { CrmWfQueueService } from './queue.service';
import { CrmWfSuppressionService } from './suppression.service';
import { CrmWfVaultService, LeadView, MsgView } from './vault.service';

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
    Pick<MsgView, 'direction' | 'occurredAt' | 'body' | 'channel'>
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
  lead: LeadView | CrmWfLead,
  messages: MsgView[],
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
  /** Rows whose phone or email already belongs to another lead at this rooftop. */
  duplicates: number;
  tasksQueued: number;
  suppressed: number;
};

export type IngestOptions = {
  /** Tag rows and messages with the import batch and record what changed, for rollback. */
  importBatchId?: string;
  /** Classify only: nothing is written, queued or suppressed. Used for import previews. */
  dryRun?: boolean;
};

/** Columns a sync may overwrite; captured before an update so a batch can be rolled back. */
const SNAPSHOT_KEYS = [
  'asOf', 'verified', 'synthetic', 'department', 'firstName', 'lastNameEnc', 'phoneEnc',
  'emailEnc', 'phoneHash', 'emailHash', 'phoneLast4', 'language', 'leadSource', 'crmStatus',
  'assignedTo', 'vehicleInterest', 'createdInCrmAt', 'lastInboundAt', 'lastOutboundAt',
  'hasFutureFollowUp', 'appointmentState', 'appointmentAt', 'visitedAt', 'crmDoNotContact',
  'humanActiveUntil', 'contentHash', 'lastProcessedHash', 'duplicateOfId', 'lastImportBatchId',
] as const;
export const IMPORT_SNAPSHOT_KEYS: readonly string[] = SNAPSHOT_KEYS;

/**
 * Brings adapter records into the read mirror and plans work. One mirror row per
 * (tenant, adapter, CRM id) — one conversation per customer and dealership. Contact fields and
 * message text are sealed before they are written. Unchanged records are not re-analysed.
 * Suppression signals are applied here, before anything is queued. A record whose phone or
 * email already belongs to another lead at the rooftop is linked as a duplicate and gets no
 * work of its own, so one customer is never worked twice.
 */
@Injectable()
export class CrmWfIntakeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: CrmWfQueueService,
    private readonly suppression: CrmWfSuppressionService,
    private readonly vault: CrmWfVaultService,
  ) {}

  async ingest(
    scope: AdapterScope,
    adapterKey: string,
    records: CrmLeadRecord[],
    now = new Date(),
    opts: IngestOptions = {},
  ): Promise<IngestSummary> {
    const s: IngestSummary = {
      received: records.length,
      created: 0,
      updated: 0,
      unchanged: 0,
      duplicates: 0,
      tasksQueued: 0,
      suppressed: 0,
    };
    const seenInFile = new Set<string>();
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
      const sealed = this.vault.sealContact(r);

      if (opts.dryRun) {
        const hashes = [sealed.phoneHash, sealed.emailHash].filter(
          (h): h is string => !!h,
        );
        const dupInFile = hashes.some((h) => seenInFile.has(h));
        hashes.forEach((h) => seenInFile.add(h));
        const dupInDb = hashes.length
          ? await this.prisma.crmWfLead.count({
              where: {
                tenantId: scope.tenantId,
                locationId: scope.locationId,
                ...(existing ? { id: { not: existing.id } } : {}),
                OR: [
                  { phoneHash: { in: hashes } },
                  { emailHash: { in: hashes } },
                ],
              },
            })
          : 0;
        if (dupInFile || dupInDb > 0) s.duplicates += 1;
        if (!existing) s.created += 1;
        else if (existing.contentHash === hash) s.unchanged += 1;
        else s.updated += 1;
        const optedOut =
          r.doNotContact === true ||
          standingOptOuts(
            r.messages
              .filter((m) => m.direction === 'INBOUND')
              .map((m) => ({
                body: m.body,
                channel: m.channel,
                occurredAt: new Date(m.occurredAt),
              })),
          ).length > 0;
        if (optedOut) s.suppressed += 1;
        continue;
      }

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
        ...sealed,
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
        ...(opts.importBatchId
          ? { lastImportBatchId: opts.importBatchId }
          : {}),
      };
      const lead = await this.prisma.$transaction(async (tx) => {
        if (opts.importBatchId)
          await tx.crmWfImportChange.create({
            data: {
              tenantId: scope.tenantId,
              batchId: opts.importBatchId,
              crmLeadId: existing?.id ?? 'pending',
              kind: existing ? 'UPDATED' : 'CREATED',
              before: existing
                ? (Object.fromEntries(
                    SNAPSHOT_KEYS.map((k) => [k, existing[k] ?? null]),
                  ) as Prisma.InputJsonValue)
                : Prisma.JsonNull,
            },
          });
        const row = existing
          ? await tx.crmWfLead.update({ where: { id: existing.id }, data })
          : await tx.crmWfLead.create({
              data: {
                ...data,
                tenantId: scope.tenantId,
                locationId: scope.locationId,
                adapterKey,
                sourceRecordId: r.sourceRecordId,
                importBatchId: opts.importBatchId ?? null,
              },
            });
        if (opts.importBatchId && !existing)
          await tx.crmWfImportChange.updateMany({
            where: {
              batchId: opts.importBatchId,
              crmLeadId: 'pending',
              kind: 'CREATED',
            },
            data: { crmLeadId: row.id },
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
              bodyEnc: this.vault.seal(m.body.slice(0, 4000)) ?? '',
              importBatchId: opts.importBatchId ?? null,
              sourceRecordId: m.sourceRecordId,
              occurredAt: new Date(m.occurredAt),
            })),
          });
        return row;
      });
      if (existing) s.updated += 1;
      else s.created += 1;
      if (await this.linkDuplicate(lead)) s.duplicates += 1;
      await this.recordObservedOutcomes(lead, r);
      await this.plan(lead.id, now, s);
    }
    return s;
  }

  /**
   * Customer identity matching without plaintext: another lead at the SAME rooftop with the
   * same phone or email hash. The oldest record is the conversation; later ones point at it.
   * Never matches across rooftops or tenants.
   */
  private async linkDuplicate(lead: CrmWfLead): Promise<boolean> {
    const or: Prisma.CrmWfLeadWhereInput[] = [];
    if (lead.phoneHash) or.push({ phoneHash: lead.phoneHash });
    if (lead.emailHash) or.push({ emailHash: lead.emailHash });
    if (!or.length) return false;
    const first = await this.prisma.crmWfLead.findFirst({
      where: {
        tenantId: lead.tenantId,
        locationId: lead.locationId,
        id: { not: lead.id },
        duplicateOfId: null,
        OR: or,
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, createdAt: true },
    });
    const primary =
      first && first.createdAt.getTime() <= lead.createdAt.getTime()
        ? first.id
        : null;
    if (lead.duplicateOfId !== primary)
      await this.prisma.crmWfLead.update({
        where: { id: lead.id },
        data: { duplicateOfId: primary },
      });
    return !!primary;
  }

  /** Decide what, if anything, this lead needs — and queue exactly one task for it. */
  async plan(
    crmLeadId: string,
    now = new Date(),
    s?: IngestSummary,
  ): Promise<PriorityResult | null> {
    const row = await this.prisma.crmWfLead.findUnique({
      where: { id: crmLeadId },
      include: { messages: true },
    });
    if (!row) return null;
    const lead = this.vault.withMessages(row);
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

    // The customer said stop — anywhere in the history, answered or not — or the CRM says
    // do-not-contact: suppress first, queue nothing.
    const optOuts = standingOptOuts(
      lead.messages.filter(
        (m) => m.direction === 'INBOUND' && m.authorType === 'CUSTOMER',
      ),
    );
    if (optOuts.length || lead.crmDoNotContact === true) {
      // One suppression per standing opt-out, so every channel the customer closed stays closed.
      for (const o of optOuts) {
        await this.suppression.suppressLead({
          tenantId: lead.tenantId,
          crmLeadId: lead.id,
          scope: o.channelScope,
          channel: o.channel,
          reason: o.reason,
          source: 'INBOUND_MESSAGE',
        });
        await this.outcome(row, 'OPT_OUT', `optout:${o.reason}:${o.channel}`, now);
      }
      if (lead.crmDoNotContact === true)
        await this.suppression.suppressLead({
          tenantId: lead.tenantId,
          crmLeadId: lead.id,
          scope: 'ALL',
          channel: 'SMS',
          reason: 'DO_NOT_CONTACT',
          source: 'CRM_PREFERENCE',
        });
      if (s) s.suppressed += 1;
      await done();
      return null;
    }

    // A duplicate of another lead's contact is worked through that lead, not on its own.
    if (lead.duplicateOfId) {
      await this.prisma.crmWfTask.updateMany({
        where: {
          tenantId: lead.tenantId,
          crmLeadId: lead.id,
          status: 'PENDING',
        },
        data: { status: 'CANCELLED', statusReason: 'duplicate_contact' },
      });
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
