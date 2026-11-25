import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ConsentService,
  normalizeEndpoint,
} from '../messaging/consent.service';

type Tx = Prisma.TransactionClient;

/**
 * Suppression list. Applied immediately and across every workflow: adding a suppression also
 * cancels the lead's open tasks and unsent actions in the same transaction, and writes an
 * opt-out into the platform consent ledger so the existing messaging stack honours it too.
 */
@Injectable()
export class CrmWfSuppressionService {
  private readonly logger = new Logger('CrmWfSuppression');
  constructor(
    private readonly prisma: PrismaService,
    private readonly consent: ConsentService,
  ) {}

  static endpointsOf(lead: { phone?: string | null; email?: string | null }) {
    const sms = lead.phone ? normalizeEndpoint('SMS', lead.phone) : null;
    const email = lead.email ? normalizeEndpoint('EMAIL', lead.email) : null;
    return { sms, email, all: [sms, email].filter((e): e is string => !!e) };
  }

  async activeFor(tenantId: string, endpoints: string[]) {
    if (!endpoints.length) return [];
    return this.prisma.crmWfSuppression.findMany({
      where: { tenantId, endpoint: { in: endpoints }, liftedAt: null },
      select: { channel: true, reason: true, endpoint: true },
    });
  }

  async suppressLead(p: {
    tenantId: string;
    crmLeadId: string;
    scope: 'CHANNEL' | 'ALL';
    channel: 'SMS' | 'EMAIL';
    reason: string;
    source: 'INBOUND_MESSAGE' | 'CRM_PREFERENCE' | 'STAFF' | 'IMPORT';
    userId?: string | null;
  }) {
    const lead = await this.prisma.crmWfLead.findFirst({
      where: { id: p.crmLeadId, tenantId: p.tenantId },
    });
    if (!lead) return { created: 0 };
    const ep = CrmWfSuppressionService.endpointsOf(lead);
    const rows: Array<{ channel: string; endpoint: string }> = [];
    if (p.scope === 'ALL')
      for (const e of ep.all) rows.push({ channel: 'ALL', endpoint: e });
    else {
      const e = p.channel === 'SMS' ? ep.sms : ep.email;
      if (e) rows.push({ channel: p.channel, endpoint: e });
    }
    const created = await this.prisma.$transaction(async (tx) => {
      let n = 0;
      for (const r of rows) {
        const dup = await tx.crmWfSuppression.findFirst({
          where: {
            tenantId: p.tenantId,
            endpoint: r.endpoint,
            channel: r.channel,
            liftedAt: null,
          },
        });
        if (dup) continue;
        await tx.crmWfSuppression.create({
          data: {
            tenantId: p.tenantId,
            channel: r.channel,
            endpoint: r.endpoint,
            reason: p.reason,
            source: p.source,
            crmLeadId: p.crmLeadId,
            createdByUserId: p.userId ?? null,
          },
        });
        n += 1;
      }
      await this.cancelOpenWork(
        tx,
        p.tenantId,
        p.crmLeadId,
        `suppressed:${p.reason}`,
      );
      await tx.auditLog.create({
        data: {
          tenantId: p.tenantId,
          userId: p.userId ?? null,
          action: 'crmwf.suppression.added',
          resource: 'CrmWfLead',
          resourceId: p.crmLeadId,
          metadata: {
            reason: p.reason,
            scope: p.scope,
            source: p.source,
            endpoints: rows.length,
          },
        },
      });
      return n;
    });
    // Mirror into the shared consent ledger (best effort; the suppression row above is the gate).
    for (const [channel, endpoint] of [
      ['SMS', ep.sms],
      ['EMAIL', ep.email],
    ] as const) {
      if (!endpoint || (p.scope === 'CHANNEL' && channel !== p.channel))
        continue;
      try {
        await this.consent.record({
          tenantId: p.tenantId,
          locationId: lead.locationId,
          channel,
          endpoint,
          purpose: 'MARKETING',
          granted: false,
          source:
            p.source === 'STAFF'
              ? 'STAFF'
              : p.source === 'INBOUND_MESSAGE'
                ? 'SMS_KEYWORD'
                : 'IMPORT',
          evidence: { via: 'crm_workforce', reason: p.reason },
        });
      } catch {
        this.logger.warn(
          'consent ledger mirror failed (suppression row still applies)',
        );
      }
    }
    return { created };
  }

  /** Cancel everything not yet sent for a lead. Used by suppression, takeover and pause. */
  async cancelOpenWork(
    tx: Tx,
    tenantId: string,
    crmLeadId: string,
    reason: string,
  ) {
    await tx.crmWfTask.updateMany({
      where: {
        tenantId,
        crmLeadId,
        status: { in: ['PENDING', 'CLAIMED', 'AWAITING_APPROVAL'] },
      },
      data: { status: 'CANCELLED', statusReason: reason, leaseExpiresAt: null },
    });
    await tx.crmWfAction.updateMany({
      where: {
        tenantId,
        crmLeadId,
        status: { in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'QUEUED'] },
      },
      data: { status: 'CANCELLED', statusReason: reason },
    });
  }

  list(tenantId: string, take = 100) {
    return this.prisma.crmWfSuppression.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  async lift(tenantId: string, id: string, userId: string, reason: string) {
    const row = await this.prisma.crmWfSuppression.findFirst({
      where: { id, tenantId, liftedAt: null },
    });
    if (!row) return null;
    // A customer's own STOP / do-not-contact is lifted only by the customer, never by staff.
    if (row.source === 'INBOUND_MESSAGE')
      return {
        refused: 'customer_opt_out_can_only_be_lifted_by_the_customer' as const,
      };
    return this.prisma.$transaction(async (tx) => {
      const out = await tx.crmWfSuppression.update({
        where: { id },
        data: { liftedAt: new Date(), liftedByUserId: userId },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          userId,
          action: 'crmwf.suppression.lifted',
          resource: 'CrmWfSuppression',
          resourceId: id,
          metadata: { reason },
        },
      });
      return out;
    });
  }
}
