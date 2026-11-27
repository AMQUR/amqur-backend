import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CrmWfIntakeService } from './intake.service';
import { CrmWfVaultService } from './vault.service';
import {
  orderPage,
  type InboundReply,
  type ReplySource,
} from './adapters/reply-detection.contract';

export type ReplyOutcome = 'applied' | 'duplicate' | 'unknown_lead';

/**
 * Applies customer replies detected in a CRM (`ReplySource`) to the workforce mirror.
 *
 *  - De-duplicated by the CRM's own message id (unique per lead): webhook + poll + retries
 *    handle a reply once.
 *  - The reply is sealed like any other message, then the lead is re-planned by the same intake
 *    rules as every other inbound: opt-out → suppression on that channel and all work stopped;
 *    needs-a-person → escalation; otherwise the customer is P0. Re-planning also cancels every
 *    unsent reply drafted before this message.
 *  - A poll moves the connector's cursor forward only after the whole page is handled, under a
 *    per-connector advisory lock, so two workers never process the same page.
 *
 * No production ReplySource is registered until Tekion access exists (UnavailableReplySource).
 */
@Injectable()
export class CrmWfReplyIngestService {
  private readonly log = new Logger('CrmWfReplyIngest');
  constructor(
    private readonly prisma: PrismaService,
    private readonly vault: CrmWfVaultService,
    private readonly intake: CrmWfIntakeService,
  ) {}

  async apply(
    scope: { tenantId: string; locationId: string },
    adapterKey: string,
    r: InboundReply,
  ): Promise<ReplyOutcome> {
    const lead = await this.prisma.crmWfLead.findFirst({
      where: {
        tenantId: scope.tenantId,
        locationId: scope.locationId,
        adapterKey,
        sourceRecordId: r.crmLeadRef,
      },
      select: {
        id: true,
        tenantId: true,
        contentHash: true,
        lastInboundAt: true,
      },
    });
    if (!lead) return 'unknown_lead';
    const at = new Date(r.occurredAt);
    const occurredAt = Number.isNaN(at.getTime()) ? new Date() : at;
    const sourceRecordId = `crm:${r.sourceMessageId}`;
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.crmWfMessage.create({
          data: {
            tenantId: lead.tenantId,
            crmLeadId: lead.id,
            direction: 'INBOUND',
            channel: r.channel === 'EMAIL' ? 'EMAIL' : 'SMS',
            authorType: 'CUSTOMER',
            bodyEnc: this.vault.seal(r.body.slice(0, 4000)) ?? '',
            sourceRecordId,
            occurredAt,
          },
        });
        await tx.crmWfLead.update({
          where: { id: lead.id },
          data: {
            lastInboundAt:
              lead.lastInboundAt && lead.lastInboundAt > occurredAt
                ? lead.lastInboundAt
                : occurredAt,
            contentHash: createHash('sha256')
              .update(`${lead.contentHash ?? ''}|${sourceRecordId}`)
              .digest('hex'),
          },
        });
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      )
        return 'duplicate';
      throw e;
    }
    await this.intake.plan(lead.id);
    return 'applied';
  }

  /** One poll of a reply source for one connector. Safe to run from several processes. */
  async pollOnce(
    scope: { tenantId: string; locationId: string },
    adapterKey: string,
    source: ReplySource,
  ) {
    const lockKey = BigInt.asIntN(
      64,
      BigInt(
        '0x' +
          createHash('sha256')
            .update(
              `crmwf-replies:${scope.tenantId}:${scope.locationId}:${adapterKey}`,
            )
            .digest('hex')
            .slice(0, 16),
      ),
    );
    const got = await this.prisma.$queryRaw<
      Array<{ ok: boolean }>
    >`SELECT pg_try_advisory_lock(${lockKey}) AS ok`;
    if (!got[0]?.ok) return { status: 'BUSY' as const, applied: 0 };
    try {
      const conn = await this.prisma.crmWfConnector.findUnique({
        where: { tenantId_locationId_adapterKey: { ...scope, adapterKey } },
      });
      if (!conn?.enabled) return { status: 'DISABLED' as const, applied: 0 };
      const page = await source.poll(scope, conn.syncCursor);
      if (page.status !== 'OK') {
        await this.prisma.crmWfConnector.update({
          where: { id: conn.id },
          data: {
            statusReason: `replies:${page.status}:${page.reason}`.slice(0, 200),
            lastHealthAt: new Date(),
          },
        });
        return { status: page.status, applied: 0 };
      }
      const { replies, commitCursor } = orderPage(page);
      const counts: Record<ReplyOutcome, number> = {
        applied: 0,
        duplicate: 0,
        unknown_lead: 0,
      };
      for (const r of replies) counts[await this.apply(scope, adapterKey, r)]++;
      // Only now, with every reply in the page handled, does the cursor move forward.
      await this.prisma.crmWfConnector.update({
        where: { id: conn.id },
        data: {
          syncCursor: commitCursor ?? conn.syncCursor,
          lastSyncAt: new Date(),
          lastError: null,
        },
      });
      if (counts.unknown_lead)
        this.log.warn(
          `replies for ${counts.unknown_lead} lead(s) not in the mirror (import or sync needed)`,
        );
      return {
        status: 'OK' as const,
        applied: counts.applied,
        duplicates: counts.duplicate,
        unknownLeads: counts.unknown_lead,
      };
    } finally {
      await this.prisma.$queryRaw`SELECT pg_advisory_unlock(${lockKey})`;
    }
  }
}
