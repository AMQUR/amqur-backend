import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  OUTBOX_LEASE_MS,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_WORKER_ID,
  OutboxService,
} from './outbox.service';
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
 * Called once when an event is dead-lettered WITHOUT its handler running (abandoned after
 * repeated lease expiry). Lets a topic move its own domain row to a terminal, operator-visible
 * state instead of leaving it waiting behind a DEAD event. Must be idempotent.
 */
export type OutboxAbandonHandler = (
  payload: Record<string, unknown>,
  meta: { id: string; tenantId: string; attempts: number },
) => Promise<void>;

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
  private readonly abandonHandlers = new Map<string, OutboxAbandonHandler>();

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

  /** See OutboxAbandonHandler. One hook per topic. */
  registerAbandonHandler(topic: string, handler: OutboxAbandonHandler): void {
    this.abandonHandlers.set(topic, handler);
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
        // Rows are handled serially under the lease taken at claim time. By the time this row's
        // turn comes the lease may have lapsed and another worker may own it: re-check on the DB
        // clock (and renew for this row) before doing anything with the in-memory copy.
        if (!(await this.outbox.beginHandling(row.id, workerId))) {
          this.metrics.increment('outbox.lease_lost');
          this.logger.warn(
            `Outbox ${row.id} topic=${row.topic} no longer owned by this worker — skipped`,
          );
          continue;
        }
        const handler = this.handlers.get(row.topic);
        // Only abandoned (lease-expired) attempts can bring a claimed row to the limit:
        // handled failures are dead-lettered in markFailed. Stop instead of crashing again.
        if (row.attempts >= OUTBOX_MAX_ATTEMPTS) {
          const dead = await this.outbox.markFailed(
            row.id,
            'abandoned_after_repeated_lease_expiry',
            row.attempts,
            { workerId, permanent: true },
          );
          this.metrics.increment('outbox.dead');
          this.logger.error(
            `Outbox ${row.id} topic=${row.topic} abandoned ${row.attempts} times (worker died or hung) → DEAD`,
          );
          // The handler never runs on this path, so the topic's own row would be left waiting
          // behind a DEAD event. The event is DEAD first: a hook that throws (or kills the
          // worker) can therefore never bring this event back or loop.
          const onAbandon = this.abandonHandlers.get(row.topic);
          if (onAbandon && dead.count === 1) {
            try {
              await onAbandon(row.payload as Record<string, unknown>, {
                id: row.id,
                tenantId: row.tenantId,
                attempts: row.attempts,
              });
            } catch (err: unknown) {
              this.metrics.increment('outbox.abandon_hook_failed');
              this.logger.error(
                `Outbox ${row.id} topic=${row.topic} abandon hook failed: ${err instanceof Error ? err.name : 'error'}`,
              );
            }
          }
          continue;
        }
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
        // Renew the lease while the handler runs so a long (but healthy) attempt is not
        // reclaimed mid-flight. If renew fails, the handler may still finish but markPublished
        // / markFailed will refuse an expired lease.
        const renew = setInterval(() => {
          void this.outbox.renewHandling(row.id, workerId).then((ok) => {
            if (!ok) this.metrics.increment('outbox.lease_renew_lost');
          });
        }, Math.floor(OUTBOX_LEASE_MS / 3));
        renew.unref?.();
        try {
          const res = await handler(row.payload as Record<string, unknown>, {
            id: row.id,
            tenantId: row.tenantId,
            attempts,
          });
          const published = await this.outbox.markPublished(
            row.id,
            workerId,
            res?.note,
          );
          if (published.count !== 1) {
            this.metrics.increment('outbox.lease_lost');
            this.logger.warn(
              `Outbox ${row.id} topic=${row.topic} handler finished after lease loss — result not published`,
            );
            continue;
          }
          this.metrics.increment('outbox.published');
          processed += 1;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'dispatch_failed';
          const permanent = err instanceof PermanentOutboxError;
          const failed = await this.outbox.markFailed(row.id, msg, attempts, {
            workerId,
            permanent,
          });
          if (failed.count !== 1) {
            this.metrics.increment('outbox.lease_lost');
            this.logger.warn(
              `Outbox ${row.id} topic=${row.topic} handler failed after lease loss — outcome not recorded`,
            );
            continue;
          }
          this.metrics.increment(permanent ? 'outbox.dead' : 'outbox.retry');
          this.logger.warn(
            `Outbox ${row.id} topic=${row.topic} failed attempt=${attempts} permanent=${permanent}: ${msg}`,
          );
        } finally {
          clearInterval(renew);
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
