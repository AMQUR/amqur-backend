import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Actor } from './control.service';
import { auditSafe, CrmWfVaultService } from './vault.service';

type Who = { phone?: string; email?: string };

/**
 * Customer data rights and retention for the CRM Workforce mirror.
 *
 *  - export: an authorized copy of what the workforce holds about one customer;
 *  - erase: removes the customer's mirror rows, messages, drafts and work items. Suppression
 *    rows are KEPT — they hold only a keyed hash, and an opt-out must outlive the data it
 *    protects, or the next import would make the customer contactable again;
 *  - purge: deletes mirror data older than the tenant's own retention period
 *    (`Tenant.dataRetentionDays`), never under a legal hold.
 *
 * The CRM stays the system of record: none of this touches the CRM itself.
 */
@Injectable()
export class CrmWfPrivacyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vault: CrmWfVaultService,
  ) {}

  private hashes(who: Who) {
    const sms = this.vault.endpoint('SMS', who.phone);
    const email = this.vault.endpoint('EMAIL', who.email);
    if (!sms && !email)
      throw new BadRequestException('a_valid_phone_or_email_is_required');
    return { sms, email, all: [sms?.hash, email?.hash].filter((h): h is string => !!h) };
  }

  private async find(tenantId: string, who: Who) {
    const h = this.hashes(who);
    const leads = await this.prisma.crmWfLead.findMany({
      where: {
        tenantId,
        OR: [
          ...(h.sms ? [{ phoneHash: h.sms.hash }] : []),
          ...(h.email ? [{ emailHash: h.email.hash }] : []),
        ],
      },
      include: { messages: { orderBy: { occurredAt: 'asc' } } },
    });
    return { h, leads };
  }

  private admin(actor: Actor, tenantId: string) {
    if (!['SUPER_ADMIN', 'ADMIN'].includes(actor.role))
      throw new ForbiddenException('privacy_request_requires_admin');
    if (actor.role !== 'SUPER_ADMIN' && actor.tenantId !== tenantId)
      throw new ForbiddenException('Cross-tenant access denied');
  }

  async export(actor: Actor, tenantId: string, who: Who, reason: string) {
    this.admin(actor, tenantId);
    const { h, leads } = await this.find(tenantId, who);
    const ids = leads.map((l) => l.id);
    const [actions, items, suppressions] = await Promise.all([
      this.prisma.crmWfAction.findMany({
        where: { tenantId, crmLeadId: { in: ids } },
        select: { id: true, actionType: true, channel: true, status: true, payload: true, createdAt: true, verifiedAt: true },
      }),
      this.prisma.crmWfWorkItem.findMany({
        where: { tenantId, crmLeadId: { in: ids } },
        select: { id: true, kind: true, status: true, title: true, createdAt: true },
      }),
      this.prisma.crmWfSuppression.findMany({
        where: { tenantId, endpointHash: { in: h.all } },
        select: { channel: true, reason: true, source: true, createdAt: true, liftedAt: true, hint: true },
      }),
    ]);
    await this.prisma.auditLog.create({
      data: {
        tenantId,
        userId: actor.userId,
        action: 'crmwf.privacy.exported',
        resource: 'CrmWfLead',
        metadata: auditSafe({ records: leads.length, reason }),
      },
    });
    return {
      generatedAt: new Date().toISOString(),
      records: leads.map((row) => {
        const l = this.vault.withMessages(row);
        return {
          dealershipLocationId: l.locationId,
          source: l.adapterKey,
          crmRecordId: l.sourceRecordId,
          asOf: l.asOf,
          firstName: l.firstName,
          lastName: l.lastName,
          phone: l.phone,
          email: l.email,
          leadSource: l.leadSource,
          crmStatus: l.crmStatus,
          vehicleInterest: l.vehicleInterest,
          messages: l.messages.map((m) => ({ direction: m.direction, channel: m.channel, at: m.occurredAt, text: m.body })),
        };
      }),
      messagesPrepared: actions.map((a) => ({ type: a.actionType, channel: a.channel, status: a.status, text: (a.payload as { body?: string }).body ?? null, createdAt: a.createdAt, sentConfirmedAt: a.verifiedAt })),
      staffWorkItems: items,
      suppressions,
    };
  }

  async erase(actor: Actor, tenantId: string, who: Who, reason: string) {
    this.admin(actor, tenantId);
    if (!reason?.trim()) throw new BadRequestException('reason_required');
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { legalHold: true } });
    if (tenant?.legalHold) throw new ConflictException('tenant_under_legal_hold');
    const { h, leads } = await this.find(tenantId, who);
    const ids = leads.map((l) => l.id);
    const counts = await this.eraseLeads(tenantId, ids);
    const suppressionsKept = await this.prisma.crmWfSuppression.count({ where: { tenantId, endpointHash: { in: h.all }, liftedAt: null } });
    await this.prisma.auditLog.create({
      data: {
        tenantId,
        userId: actor.userId,
        action: 'crmwf.privacy.erased',
        resource: 'CrmWfLead',
        metadata: auditSafe({ ...counts, suppressionsKept, reason }),
      },
    });
    return { ...counts, suppressionsKept };
  }

  /** Remove mirror rows and everything hanging off them. Suppressions are never deleted. */
  async eraseLeads(tenantId: string, ids: string[]) {
    if (!ids.length) return { leads: 0, messages: 0, actions: 0, tasks: 0, workItems: 0 };
    return this.prisma.$transaction(async (tx) => {
      const actionIds = (await tx.crmWfAction.findMany({ where: { tenantId, crmLeadId: { in: ids } }, select: { id: true } })).map((a) => a.id);
      await tx.crmWfReview.deleteMany({ where: { tenantId, actionId: { in: actionIds } } });
      const actions = await tx.crmWfAction.deleteMany({ where: { tenantId, crmLeadId: { in: ids } } });
      const tasks = await tx.crmWfTask.deleteMany({ where: { tenantId, crmLeadId: { in: ids } } });
      const workItems = await tx.crmWfWorkItem.deleteMany({ where: { tenantId, crmLeadId: { in: ids } } });
      await tx.crmWfOutcome.deleteMany({ where: { tenantId, crmLeadId: { in: ids } } });
      await tx.crmWfUsage.updateMany({ where: { tenantId, crmLeadId: { in: ids } }, data: { crmLeadId: null } });
      await tx.crmWfImportChange.deleteMany({ where: { tenantId, crmLeadId: { in: ids } } });
      await tx.crmWfSuppression.updateMany({ where: { tenantId, crmLeadId: { in: ids } }, data: { crmLeadId: null } });
      await tx.crmWfLead.updateMany({ where: { tenantId, duplicateOfId: { in: ids } }, data: { duplicateOfId: null } });
      const messages = await tx.crmWfMessage.deleteMany({ where: { tenantId, crmLeadId: { in: ids } } });
      const leads = await tx.crmWfLead.deleteMany({ where: { tenantId, id: { in: ids } } });
      return { leads: leads.count, messages: messages.count, actions: actions.count, tasks: tasks.count, workItems: workItems.count };
    });
  }

  async retention(tenantId: string) {
    const t = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { dataRetentionDays: true, legalHold: true } });
    const days = Math.max(30, t?.dataRetentionDays ?? 365);
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const due = await this.prisma.crmWfLead.count({ where: this.expired(tenantId, cutoff) });
    return { retentionDays: days, legalHold: !!t?.legalHold, cutoff, recordsPastRetention: due, vaultReady: this.vault.isReady() };
  }

  private expired(tenantId: string, cutoff: Date) {
    return {
      tenantId,
      updatedAt: { lt: cutoff },
      AND: [
        { OR: [{ lastInboundAt: null }, { lastInboundAt: { lt: cutoff } }] },
        { OR: [{ lastOutboundAt: null }, { lastOutboundAt: { lt: cutoff } }] },
      ],
    };
  }

  /** Retention purge for every tenant. Called by the engine at most once a day. */
  async purgeExpired(now = new Date(), batch = 500) {
    const tenants = await this.prisma.crmWfLead.findMany({ distinct: ['tenantId'], select: { tenantId: true } });
    let purged = 0;
    for (const { tenantId } of tenants) {
      const t = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { dataRetentionDays: true, legalHold: true } });
      if (!t || t.legalHold) continue;
      const cutoff = new Date(now.getTime() - Math.max(30, t.dataRetentionDays) * 86_400_000);
      const ids = (await this.prisma.crmWfLead.findMany({ where: this.expired(tenantId, cutoff), select: { id: true }, take: batch })).map((l) => l.id);
      if (!ids.length) continue;
      const c = await this.eraseLeads(tenantId, ids);
      purged += c.leads;
      await this.prisma.auditLog.create({ data: { tenantId, action: 'crmwf.privacy.retention_purged', resource: 'CrmWfLead', metadata: { ...c, cutoff: cutoff.toISOString() } } });
    }
    return purged;
  }
}
