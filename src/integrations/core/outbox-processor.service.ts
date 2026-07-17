import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OutboxService } from './outbox.service';
import { OutboxStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import axios from 'axios';

/**
 * Processes transactional outbox events with bounded retries + DLQ (DEAD).
 * Safe to run in API process for pilot; prefer dedicated worker in multi-replica prod.
 */
@Injectable()
export class OutboxProcessorService {
  private readonly logger = new Logger(OutboxProcessorService.name);
  private running = false;

  constructor(
    private readonly outbox: OutboxService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick() {
    if (process.env.OUTBOX_PROCESSOR_ENABLED === 'false') return;
    await this.processBatch();
  }

  async processBatch(limit = 50): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let processed = 0;
    try {
      const rows = await this.outbox.claimPending(limit);
      for (const row of rows) {
        await this.prisma.outboxEvent.update({
          where: { id: row.id },
          data: { status: OutboxStatus.PROCESSING },
        });
        try {
          await this.dispatch(
            row.topic,
            row.payload as Record<string, unknown>,
          );
          await this.outbox.markPublished(row.id);
          processed += 1;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'dispatch_failed';
          await this.outbox.markFailed(row.id, msg, row.attempts + 1);
          this.logger.warn(
            `Outbox ${row.id} topic=${row.topic} failed attempt=${row.attempts + 1}: ${msg}`,
          );
        }
      }
    } finally {
      this.running = false;
    }
    return processed;
  }

  private async dispatch(topic: string, payload: Record<string, unknown>) {
    switch (topic) {
      case 'crm.webhook':
      case 'escalation.notify': {
        const url =
          (typeof payload.webhookUrl === 'string' && payload.webhookUrl) ||
          process.env.CRM_WEBHOOK_URL?.trim();
        if (!url) {
          throw new Error('CRM_WEBHOOK_URL_missing');
        }
        const body = { ...payload };
        delete body.webhookUrl;
        await axios.post(url, body, { timeout: 8_000 });
        if (
          typeof payload.escalationId === 'string' &&
          typeof payload.tenantId === 'string'
        ) {
          await this.prisma.escalation.updateMany({
            where: {
              id: payload.escalationId,
              tenantId: payload.tenantId,
            },
            data: { notifiedAt: new Date() },
          });
        }
        return;
      }
      default:
        this.logger.warn(
          `Unknown outbox topic=${topic} — marking published (no-op)`,
        );
    }
  }
}
