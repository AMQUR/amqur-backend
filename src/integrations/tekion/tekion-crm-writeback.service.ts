import { Injectable, Logger } from '@nestjs/common';
import { CrmSyncStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TekionNotAuthorizedError, TekionProvider } from './tekion.provider';
import { PermanentOutboxError } from '../core/outbox-processor.service';

/**
 * Executes a Tekion lead writeback that CrmSyncService already gated. External identifiers
 * are stored ONLY from a provider response; a not-authorized/disabled provider leaves the
 * lead NONE/FAILED — it is never marked SYNCED.
 */
@Injectable()
export class TekionCrmWritebackService {
  private readonly logger = new Logger(TekionCrmWritebackService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tekion: TekionProvider,
  ) {}

  async syncLead(tenantId: string, leadId: string) {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, tenantId },
    });
    if (!lead) throw new PermanentOutboxError('lead_not_found');
    if (
      !this.tekion.isLiveConfigured() ||
      !this.tekion.capabilities().crmLeadCreateOrUpdate
    ) {
      throw new PermanentOutboxError('tekion_not_authorized');
    }
    const idempotencyKey = `lead:${lead.tenantId}:${lead.conversationId ?? lead.id}`;
    try {
      if (
        lead.externalCrmLeadId &&
        lead.crmSyncStatus === CrmSyncStatus.SYNCED
      ) {
        await this.tekion.appendActivity({
          tenantId: lead.tenantId,
          externalLeadId: lead.externalCrmLeadId,
          externalCustomerId: lead.externalCrmCustomerId,
          summary: `AMQUR update stage=${lead.stage} score=${lead.score}`,
          channel: 'widget',
          idempotencyKey: `activity:${idempotencyKey}:${lead.updatedAt.toISOString()}`,
        });
        await this.prisma.lead.update({
          where: { id: lead.id },
          data: { crmLastSyncedAt: new Date(), crmLastError: null },
        });
        return;
      }
      const res = await this.tekion.createOrUpdateLead({
        tenantId: lead.tenantId,
        locationId: lead.locationId,
        firstName: lead.firstName,
        lastName: lead.lastName,
        email: lead.email,
        phone: lead.phone,
        interestedVin: lead.interestedVin,
        source: lead.source,
        conversationId: lead.conversationId,
        idempotencyKey,
        utm: {
          source: lead.utmSource ?? undefined,
          medium: lead.utmMedium ?? undefined,
          campaign: lead.utmCampaign ?? undefined,
        },
      });
      await this.prisma.lead.update({
        where: { id: lead.id },
        data: {
          externalCrmLeadId: res.externalLeadId,
          externalCrmCustomerId: res.externalCustomerId ?? null,
          crmSyncStatus: CrmSyncStatus.SYNCED,
          crmLastSyncedAt: new Date(),
          crmLastError: null,
        },
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.prisma.lead.update({
        where: { id: lead.id },
        data: {
          crmSyncStatus: CrmSyncStatus.FAILED,
          crmLastError: msg.slice(0, 300),
        },
      });
      if (e instanceof TekionNotAuthorizedError)
        throw new PermanentOutboxError(msg);
      throw e;
    }
  }
}
