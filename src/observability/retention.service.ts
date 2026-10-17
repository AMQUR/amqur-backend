import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

export type RetentionReport = {
  tenant: string;
  skipped?: 'legal_hold';
  conversationsDeleted: number;
  messagesDeleted: number;
  analyticsDeleted: number;
  filesMarkedDeleted: number;
};

/**
 * Data retention — HARD DELETION, stated plainly (this job does not archive).
 *
 *  - Conversations + their messages: hard-deleted when LAST ACTIVITY is older than
 *    Tenant.dataRetentionDays. Leads/appointments/requests keep their business record but
 *    lose the conversation link (FK SET NULL).
 *  - Analytics events: hard-deleted after Tenant.analyticsRetentionDays.
 *  - Uploaded files linked to deleted conversations: marked deleted (binary purge by storage
 *    lifecycle).
 *  - Audit logs and consent records: NEVER deleted here (security/compliance evidence).
 *  - Tenant.legalHold=true: nothing is deleted for that tenant.
 * Per-customer deletion/pseudonymization requests use PrivacyService (operator-initiated).
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async runScheduled(): Promise<void> {
    if (process.env.PROCESS_ROLE === 'api') return;
    await this.enforceRetention();
  }

  async enforceRetention(now = new Date()): Promise<RetentionReport[]> {
    const tenants = await this.prisma.tenant.findMany({
      select: {
        id: true,
        slug: true,
        dataRetentionDays: true,
        analyticsRetentionDays: true,
        legalHold: true,
      },
    });
    const reports: RetentionReport[] = [];
    for (const t of tenants) {
      if (t.legalHold) {
        reports.push({
          tenant: t.slug,
          skipped: 'legal_hold',
          conversationsDeleted: 0,
          messagesDeleted: 0,
          analyticsDeleted: 0,
          filesMarkedDeleted: 0,
        });
        continue;
      }
      const days = t.dataRetentionDays > 0 ? t.dataRetentionDays : 365;
      const cutoff = new Date(now.getTime() - days * 86_400_000);
      const conversations = await this.prisma.conversation.findMany({
        where: { tenantId: t.id, lastActivityAt: { lt: cutoff } },
        select: { id: true },
        take: 500,
      });
      const ids = conversations.map((c) => c.id);
      let messagesDeleted = 0;
      let filesMarkedDeleted = 0;
      if (ids.length) {
        const res = await this.prisma.$transaction([
          this.prisma.message.deleteMany({
            where: { conversationId: { in: ids } },
          }),
          this.prisma.fileObject.updateMany({
            where: {
              tenantId: t.id,
              conversationId: { in: ids },
              deletedAt: null,
            },
            data: { deletedAt: now },
          }),
          this.prisma.conversation.deleteMany({
            where: { id: { in: ids }, tenantId: t.id },
          }),
        ]);
        messagesDeleted = res[0].count;
        filesMarkedDeleted = res[1].count;
      }
      const aDays =
        t.analyticsRetentionDays > 0 ? t.analyticsRetentionDays : 400;
      const analytics = await this.prisma.analyticsEvent.deleteMany({
        where: {
          tenantId: t.id,
          occurredAt: { lt: new Date(now.getTime() - aDays * 86_400_000) },
        },
      });
      const report = {
        tenant: t.slug,
        conversationsDeleted: ids.length,
        messagesDeleted,
        analyticsDeleted: analytics.count,
        filesMarkedDeleted,
      };
      reports.push(report);
      if (ids.length || analytics.count) {
        await this.prisma.auditLog.create({
          data: {
            tenantId: t.id,
            action: 'retention.hard_delete',
            metadata: { ...report, cutoff: cutoff.toISOString() },
          },
        });
        this.logger.log(`Retention tenant=${t.slug} ${JSON.stringify(report)}`);
      }
    }
    return reports;
  }
}
