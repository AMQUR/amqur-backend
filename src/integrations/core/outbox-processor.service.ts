import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OUTBOX_WORKER_ID, OutboxService } from './outbox.service';
import { PrismaService } from '../../prisma/prisma.service';
import axios from 'axios';
import { MetricsService } from '../../observability/metrics.service';
import { signWebhookPayload } from '../../common/security/webhook-signature';

/** Throw from a handler when retrying cannot help (bad payload, capability off, 4xx). */
export class PermanentOutboxError extends Error {}

export type OutboxHandlerResult = { note?: string } | void;
export type OutboxHandler = (
  payload: Record<string, unknown>,
  meta: { id: string; tenantId: string; attempts: number },
) => Promise<OutboxHandlerResult>;

/**
 * Multi-worker-safe outbox dispatcher. Claiming is atomic in OutboxService.claimPending;
 * handlers must be idempotent (keyed by event id / idempotency key) because delivery is
 * at-least-once. Unknown topics go to DEAD — they are never silently marked published.
 */
@Injectable()
export class OutboxProcessorService {
  private readonly logger = new Logger(OutboxProcessorService.name);
  private running = false;
  private readonly handlers = new Map<string, OutboxHandler>();

  constructor(
    private readonly outbox: OutboxService,
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
  ) {
    this.registerHandler('crm.webhook', (p, m) => this.deliverWebhook(p, m));
    this.registerHandler('escalation.notify', (p, m) =>
      this.deliverWebhook(p, m),
    );
  }

  registerHandler(topic: string, handler: OutboxHandler): void {
    this.handlers.set(topic, handler);
  }

  hasHandler(topic: string): boolean {
    return this.handlers.has(topic);
  }

  @Cron(CronExpression.EVERY_10_SECONDS)
  async tick() {
    if (process.env.OUTBOX_PROCESSOR_ENABLED === 'false') return;
    await this.processBatch();
  }

  async processBatch(limit = 50, workerId = OUTBOX_WORKER_ID): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let processed = 0;
    try {
      const rows = await this.outbox.claimPending(limit, workerId);
      this.metrics.increment('outbox.claimed', rows.length);
      for (const row of rows) {
        const handler = this.handlers.get(row.topic);
        const attempts = row.attempts + 1;
        if (!handler) {
          await this.outbox.markFailed(
            row.id,
            `no_handler_for_topic:${row.topic}`,
            attempts,
            {
              workerId,
              permanent: true,
            },
          );
          this.metrics.increment('outbox.dead');
          this.logger.error(
            `Outbox ${row.id} topic=${row.topic} has no handler → DEAD`,
          );
          continue;
        }
        try {
          const res = await handler(row.payload as Record<string, unknown>, {
            id: row.id,
            tenantId: row.tenantId,
            attempts,
          });
          await this.outbox.markPublished(row.id, workerId, res?.note);
          this.metrics.increment('outbox.published');
          processed += 1;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'dispatch_failed';
          const permanent = err instanceof PermanentOutboxError;
          await this.outbox.markFailed(row.id, msg, attempts, {
            workerId,
            permanent,
          });
          this.metrics.increment(permanent ? 'outbox.dead' : 'outbox.retry');
          this.logger.warn(
            `Outbox ${row.id} topic=${row.topic} failed attempt=${attempts} permanent=${permanent}: ${msg}`,
          );
        }
      }
    } finally {
      this.running = false;
    }
    return processed;
  }

  private async deliverWebhook(
    payload: Record<string, unknown>,
    meta: { id: string; tenantId: string },
  ): Promise<OutboxHandlerResult> {
    const url =
      (typeof payload.webhookUrl === 'string' && payload.webhookUrl) ||
      process.env.CRM_WEBHOOK_URL?.trim();
    if (!url) {
      throw new PermanentOutboxError('CRM_WEBHOOK_URL_missing');
    }
    const body = { ...payload };
    delete body.webhookUrl;
    const raw = JSON.stringify(body);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-amqur-event-id': meta.id,
    };
    const secret = process.env.CRM_WEBHOOK_SIGNING_SECRET?.trim();
    if (secret) {
      Object.assign(headers, signWebhookPayload(raw, secret, meta.id));
    }
    try {
      await axios.post(url, raw, { timeout: 8_000, headers });
    } catch (e: unknown) {
      const status = axios.isAxiosError(e) ? e.response?.status : undefined;
      if (
        status &&
        status >= 400 &&
        status < 500 &&
        status !== 408 &&
        status !== 429
      ) {
        throw new PermanentOutboxError(`webhook_rejected_${status}`);
      }
      throw e;
    }
    if (
      typeof payload.escalationId === 'string' &&
      typeof payload.tenantId === 'string'
    ) {
      await this.prisma.escalation.updateMany({
        where: { id: payload.escalationId, tenantId: payload.tenantId },
        data: { notifiedAt: new Date() },
      });
    }
  }
}
