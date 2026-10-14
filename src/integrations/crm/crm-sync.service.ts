import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { CrmSyncStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { OutboxService } from '../core/outbox.service';
import {
  OutboxProcessorService,
  PermanentOutboxError,
} from '../core/outbox-processor.service';
import { FeatureFlagsService } from '../../feature-flags/feature-flags.service';
import { TekionProvider } from '../tekion/tekion.provider';
import { TekionCrmWritebackService } from '../tekion/tekion-crm-writeback.service';
import {
  resolveTekionCapabilities,
  TekionConnectionConfig,
} from '../tekion/tekion.capabilities';
import { MetricsService } from '../../observability/metrics.service';

export type CrmGate =
  | { open: true; provider: 'TEKION'; connectionId: string }
  | {
      open: false;
      reason:
        | 'flag_off'
        | 'no_connection'
        | 'not_live_ready'
        | 'contract_unverified'
        | 'client_not_implemented'
        | 'capability_not_granted';
    };

/**
 * Provider-agnostic CRM writeback entry point. Business code calls onLeadChanged /
 * onAppointmentChanged; this service decides — via capability gates — whether a durable
 * outbox job is created. Disabled providers produce NO job and NO fake sync state.
 */
@Injectable()
export class CrmSyncService implements OnModuleInit {
  private readonly logger = new Logger(CrmSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly processor: OutboxProcessorService,
    private readonly flags: FeatureFlagsService,
    private readonly tekion: TekionProvider,
    private readonly writeback: TekionCrmWritebackService,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit() {
    this.processor.registerHandler('crm.tekion.lead-sync', async (p, m) => {
      if (typeof p.leadId !== 'string')
        throw new PermanentOutboxError('bad_payload');
      await this.writeback.syncLead(m.tenantId, p.leadId);
    });
    this.processor.registerHandler('appointment.requested', async (p, m) => {
      // Staff see every request in Command Center from the DB. External delivery happens only
      // when a destination is configured; otherwise the event is closed with an honest note.
      const url = process.env.CRM_WEBHOOK_URL?.trim();
      if (!url) return { note: 'no_external_destination_configured' };
      await this.outbox.enqueue({
        tenantId: m.tenantId,
        topic: 'crm.webhook',
        idempotencyKey: `crm-webhook:appointment:${String(p.appointmentId)}`,
        payload: { event: 'APPOINTMENT_REQUESTED', ...p },
      });
      return { note: 'forwarded_to_crm_webhook' };
    });
    this.processor.registerHandler('appointment.provider.cancel', async () => {
      // No scheduling adapter is authorized today; a provider-owned booking cannot exist.
      throw new PermanentOutboxError('no_authorized_scheduler');
    });
  }

  async tekionGate(
    tenantId: string,
    locationId?: string | null,
  ): Promise<CrmGate> {
    const flags = await this.flags.resolve(tenantId, locationId);
    if (flags.tekionIntegration !== true)
      return { open: false, reason: 'flag_off' };
    const conn = await this.prisma.integrationConnection.findFirst({
      where: {
        tenantId,
        provider: 'TEKION',
        capability: 'crm',
        OR: locationId
          ? [{ locationId }, { locationId: null }]
          : [{ locationId: null }],
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (!conn || !conn.enabled) return { open: false, reason: 'no_connection' };
    if (!conn.liveReady) return { open: false, reason: 'not_live_ready' };
    const caps = resolveTekionCapabilities(
      conn.config as TekionConnectionConfig,
    );
    if (!caps.crmLeadCreateOrUpdate)
      return { open: false, reason: 'contract_unverified' };
    if (!this.tekion.isLiveConfigured())
      return { open: false, reason: 'client_not_implemented' };
    return { open: true, provider: 'TEKION', connectionId: conn.id };
  }

  async onLeadChanged(
    tenantId: string,
    locationId: string | null | undefined,
    leadId: string,
    event: 'lead.created' | 'lead.updated',
  ) {
    const gate = await this.tekionGate(tenantId, locationId);
    if (gate.open) {
      await this.prisma.lead.updateMany({
        where: { id: leadId, tenantId },
        data: { crmSyncStatus: CrmSyncStatus.PENDING },
      });
      await this.outbox.enqueue({
        tenantId,
        topic: 'crm.tekion.lead-sync',
        idempotencyKey: `tekion-lead:${leadId}:${event}:${Math.floor(Date.now() / 60_000)}`,
        payload: { leadId },
      });
      this.metrics.increment('crm.tekion.enqueued');
    } else {
      this.metrics.increment(`crm.tekion.gated.${gate.reason}`);
    }
    // Generic dealer CRM webhook (ADF/JSON receiver) — durable via outbox, signed when secret set.
    if (process.env.CRM_WEBHOOK_URL?.trim() && event === 'lead.created') {
      const lead = await this.prisma.lead.findFirst({
        where: { id: leadId, tenantId },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          phone: true,
          email: true,
          interestedVin: true,
          stage: true,
          score: true,
          source: true,
          nextBestAction: true,
        },
      });
      if (lead) {
        await this.outbox.enqueue({
          tenantId,
          topic: 'crm.webhook',
          idempotencyKey: `crm-webhook:lead:${leadId}`,
          payload: {
            event: 'LEAD_CREATED',
            tenantId,
            locationId: locationId ?? null,
            lead,
          },
        });
      }
    }
  }
}
