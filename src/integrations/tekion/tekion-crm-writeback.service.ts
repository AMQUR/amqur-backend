import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TekionProvider } from './tekion.provider';
import { OutboxService } from '../core/outbox.service';
import { CrmSyncStatus } from '@prisma/client';
import { FeatureFlagsService } from '../../feature-flags/feature-flags.service';

/**
 * Idempotent CRM writeback via Tekion adapter (mock until liveReady).
 * Never creates duplicate leads for the same conversation+contact identity.
 */
@Injectable()
export class TekionCrmWritebackService {
  private readonly logger = new Logger(TekionCrmWritebackService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tekion: TekionProvider,
    private readonly outbox: OutboxService,
    private readonly flags: FeatureFlagsService,
  ) {}

  async syncLead(leadId: string) {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) return null;

    const flags = await this.flags.resolve(lead.tenantId, lead.locationId);
    if (!flags.tekionIntegration && !this.tekion.isLiveConfigured()) {
      // Still allow mock writeback for staging when explicitly requested via outbox topic
      this.logger.debug(`Tekion CRM sync skipped (flag off) lead=${leadId}`);
    }

    const idempotencyKey = `lead:${lead.tenantId}:${lead.conversationId ?? lead.id}:${lead.email ?? lead.phone ?? 'anon'}`;

    if (lead.externalCrmLeadId && lead.crmSyncStatus === CrmSyncStatus.SYNCED) {
      await this.tekion.appendActivity({
        tenantId: lead.tenantId,
        externalLeadId: lead.externalCrmLeadId,
        externalCustomerId: lead.externalCrmCustomerId,
        summary: `AMQUR update score=${lead.score} stage=${lead.stage}`,
        channel: 'widget',
        idempotencyKey: `activity:${idempotencyKey}:${lead.updatedAt.toISOString()}`,
      });
      return lead;
    }

    try {
      const result = await this.tekion.createOrUpdateLead({
        tenantId: lead.tenantId,
        locationId: lead.locationId,
        firstName: lead.firstName,
        lastName: lead.lastName,
        email: lead.email,
        phone: lead.phone,
        interestedVin: lead.interestedVin,
        source: lead.source,
        notes: lead.notes,
        conversationId: lead.conversationId,
        idempotencyKey,
        utm: {
          source: lead.utmSource ?? undefined,
          medium: lead.utmMedium ?? undefined,
          campaign: lead.utmCampaign ?? undefined,
        },
      });

      const updated = await this.prisma.lead.update({
        where: { id: lead.id },
        data: {
          externalCrmLeadId: result.externalLeadId,
          externalCrmCustomerId: result.externalCustomerId,
          crmSyncStatus: CrmSyncStatus.SYNCED,
          crmLastSyncedAt: new Date(),
          crmLastError: null,
        },
      });

      await this.outbox.enqueue({
        tenantId: lead.tenantId,
        topic: 'integration.tekion.lead-writeback',
        idempotencyKey,
        payload: {
          leadId: lead.id,
          externalLeadId: result.externalLeadId,
          duplicated: result.duplicated,
          provider: result.provider,
          live: this.tekion.isLiveConfigured(),
        },
      });

      return updated;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.prisma.lead.update({
        where: { id: lead.id },
        data: {
          crmSyncStatus: CrmSyncStatus.FAILED,
          crmLastError: msg.slice(0, 500),
        },
      });
      throw e;
    }
  }
}
