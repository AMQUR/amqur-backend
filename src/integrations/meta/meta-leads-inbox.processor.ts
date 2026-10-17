import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  IntegrationProvider,
  WebhookInbox,
  WebhookInboxStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LeadsService } from '../../leads/leads.service';
import {
  extractMetaLeadgenWebhookContext,
  payloadAsJsonRecord,
} from './meta-lead-payload';
import {
  parseMetaGraphLeadFieldData,
  type MetaGraphLeadFetchResult,
} from './meta-lead-graph';
import {
  MetaGraphLeadClientService,
  type MetaGraphLeadClient,
} from './meta-graph-lead.client';

export type MetaInboxProcessResult =
  | { outcome: 'processed'; leadId: string; created: boolean }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'retry'; reason: string }
  | { outcome: 'failed'; reason: string };

/**
 * Materializes signed Meta WebhookInbox rows (RECEIVED) into Lead records.
 * Fail-closed: no invented name/phone/email; idempotent on leadgen_id / externalEventId.
 */
@Injectable()
export class MetaLeadsInboxProcessor {
  private readonly logger = new Logger(MetaLeadsInboxProcessor.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly leads: LeadsService,
    private readonly graphClient: MetaGraphLeadClientService,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async cronTick() {
    if (process.env.META_LEAD_MATERIALIZER_ENABLED === 'false') return;
    if (process.env.PROCESS_ROLE === 'worker') return;
    await this.processBatch();
  }

  async processBatch(limit = 25): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let done = 0;
    try {
      const rows = await this.prisma.webhookInbox.findMany({
        where: {
          provider: IntegrationProvider.META,
          status: WebhookInboxStatus.RECEIVED,
          signatureValid: true,
        },
        orderBy: { createdAt: 'asc' },
        take: limit,
      });
      for (const row of rows) {
        const res = await this.processRow(row);
        if (res.outcome === 'processed') done += 1;
      }
    } finally {
      this.running = false;
    }
    return done;
  }

  async processRow(
    row: WebhookInbox,
    graphClient: MetaGraphLeadClient = this.graphClient,
  ): Promise<MetaInboxProcessResult> {
    if (row.provider !== IntegrationProvider.META) {
      return { outcome: 'skipped', reason: 'wrong_provider' };
    }
    if (row.status !== WebhookInboxStatus.RECEIVED) {
      return { outcome: 'skipped', reason: 'not_received' };
    }
    if (!row.signatureValid) {
      return { outcome: 'skipped', reason: 'signature_invalid' };
    }

    const leadgenId = row.externalEventId?.trim();
    if (!leadgenId || leadgenId.startsWith('rejected:')) {
      await this.markFailed(row.id, 'invalid_external_event_id');
      return { outcome: 'failed', reason: 'invalid_external_event_id' };
    }

    const existingLead = await this.leads.findByMetaLeadgenId(
      row.tenantId,
      leadgenId,
    );
    if (existingLead) {
      await this.markProcessed(row.id);
      return {
        outcome: 'processed',
        leadId: existingLead.id,
        created: false,
      };
    }

    const payloadRecord = payloadAsJsonRecord(row.payload);
    const webhookContext = extractMetaLeadgenWebhookContext(
      payloadRecord ?? row.payload,
    );
    const metaContext = {
      pageId: webhookContext?.pageId,
      formId: webhookContext?.formId,
      adId: webhookContext?.adId,
      adgroupId: webhookContext?.adgroupId,
    };

    const graph = await graphClient.fetchLeadgen(leadgenId);
    if (graph.ok === false) {
      return this.handleGraphFailure(row, leadgenId, metaContext, graph);
    }

    const verified = parseMetaGraphLeadFieldData(graph.fieldData);
    const hasContact = !!(verified.email || verified.phone);
    const hasName = !!(verified.firstName || verified.lastName);
    const needsStaffReview = !hasContact;

    const { lead, created } = await this.leads.upsertFromMetaLeadgen({
      tenantId: row.tenantId,
      leadgenId,
      webhookInboxId: row.id,
      firstName: verified.firstName,
      lastName: verified.lastName,
      phone: verified.phone,
      email: verified.email,
      zipCode: verified.zipCode,
      metaContext: {
        ...metaContext,
        graphLeadId: graph.graphLeadId,
      },
      needsStaffReview: needsStaffReview || !hasName,
    });

    await this.markProcessed(row.id);
    this.logger.log(
      `meta inbox materialized inbox=${row.id} lead=${lead.id} created=${created} staffReview=${needsStaffReview || !hasName}`,
    );
    return { outcome: 'processed', leadId: lead.id, created };
  }

  private async handleGraphFailure(
    row: WebhookInbox,
    leadgenId: string,
    metaContext: {
      pageId?: string;
      formId?: string;
      adId?: string;
      adgroupId?: string;
    },
    graph: Extract<MetaGraphLeadFetchResult, { ok: false }>,
  ): Promise<MetaInboxProcessResult> {
    if (graph.reason === 'not_configured') {
      const { lead, created } = await this.leads.upsertFromMetaLeadgen({
        tenantId: row.tenantId,
        leadgenId,
        webhookInboxId: row.id,
        metaContext,
        needsStaffReview: true,
      });
      await this.markProcessed(row.id, 'graph_not_configured_minimal_lead');
      return { outcome: 'processed', leadId: lead.id, created };
    }

    if (graph.reason === 'lead_not_found') {
      await this.markFailed(row.id, 'graph_lead_not_found');
      return { outcome: 'failed', reason: 'graph_lead_not_found' };
    }

    if (graph.reason === 'malformed') {
      const { lead, created } = await this.leads.upsertFromMetaLeadgen({
        tenantId: row.tenantId,
        leadgenId,
        webhookInboxId: row.id,
        metaContext,
        needsStaffReview: true,
      });
      await this.markProcessed(row.id, graph.message ?? 'graph_malformed');
      return { outcome: 'processed', leadId: lead.id, created };
    }

    await this.prisma.webhookInbox.update({
      where: { id: row.id },
      data: {
        errorMessage: (graph.message ?? graph.reason).slice(0, 500),
      },
    });
    return {
      outcome: 'retry',
      reason: graph.reason,
    };
  }

  private markProcessed(id: string, note?: string) {
    return this.prisma.webhookInbox.update({
      where: { id },
      data: {
        status: WebhookInboxStatus.PROCESSED,
        processedAt: new Date(),
        ...(note ? { errorMessage: note.slice(0, 500) } : { errorMessage: null }),
      },
    });
  }

  private markFailed(id: string, reason: string) {
    return this.prisma.webhookInbox.update({
      where: { id },
      data: {
        status: WebhookInboxStatus.FAILED,
        processedAt: new Date(),
        errorMessage: reason.slice(0, 500),
      },
    });
  }
}
