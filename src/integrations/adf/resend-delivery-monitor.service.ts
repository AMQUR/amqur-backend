import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { MetricsService } from '../../observability/metrics.service';
import { LeadDeliveryService } from './lead-delivery.service';
import { LeadDeliveryEnv, readLeadDeliveryEnv } from './lead-delivery-gates';
import {
  FetchLike,
  RESEND_API_ORIGIN,
  resendEmailIdFromStatus,
} from './transports/resend.transport';

/** Resend `last_event` values that mean the message will not reach the recipient. */
const FAILED_EVENTS = new Set(['bounced', 'failed', 'suppressed', 'canceled']);
const WATCH_WINDOW_MS = 72 * 60 * 60 * 1000;
const BATCH = 25;

/**
 * Delivery, bounce and failure monitoring for lead mail accepted by Resend. Every few minutes
 * it asks Resend for the last event of each recently ACCEPTED live delivery and records
 * DELIVERED or DEAD (bounce). "Delivered" means the recipient's mail server took the message;
 * it is NOT evidence that a CRM created a lead. Needs an API key allowed to read emails.
 */
@Injectable()
export class ResendDeliveryMonitorService {
  private readonly logger = new Logger(ResendDeliveryMonitorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly deliveries: LeadDeliveryService,
    private readonly metrics: MetricsService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async tick(): Promise<void> {
    if (process.env.OUTBOX_PROCESSOR_ENABLED === 'false') return;
    try {
      await this.poll();
    } catch {
      this.logger.warn('resend delivery monitor sweep failed');
    }
  }

  async poll(
    env: LeadDeliveryEnv = readLeadDeliveryEnv(),
    fetchImpl: FetchLike = fetch as unknown as FetchLike,
    now: Date = new Date(),
  ): Promise<{ checked: number; delivered: number; bounced: number }> {
    const out = { checked: 0, delivered: 0, bounced: 0 };
    if (!env.resendApiKey) return out;
    const rows = await this.prisma.leadDelivery.findMany({
      where: {
        status: 'ACCEPTED',
        providerName: 'resend',
        deliveryMode: 'live',
        acceptedAt: { gte: new Date(now.getTime() - WATCH_WINDOW_MS) },
      },
      orderBy: { acceptedAt: 'asc' },
      take: BATCH,
      select: {
        id: true,
        tenantId: true,
        status: true,
        providerRawStatus: true,
      },
    });
    for (const row of rows) {
      const emailId = resendEmailIdFromStatus(row.providerRawStatus);
      if (!emailId) continue;
      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await fetchImpl(`${RESEND_API_ORIGIN}/emails/${emailId}`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${env.resendApiKey}` },
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        this.metrics.increment('adf.delivery.monitor_error');
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        // A send-only key cannot read message status. Sending still works; monitoring does not.
        this.metrics.increment('adf.delivery.monitor_unauthorized');
        this.logger.warn(
          'resend delivery monitor: API key cannot read email status (needs full access)',
        );
        return out;
      }
      if (res.status === 429) return out;
      if (res.status !== 200) {
        this.metrics.increment('adf.delivery.monitor_error');
        continue;
      }
      out.checked++;
      const body = (await res.json().catch(() => null)) as {
        last_event?: unknown;
      } | null;
      const event = typeof body?.last_event === 'string' ? body.last_event : '';
      const outcome =
        event === 'delivered'
          ? 'delivered'
          : FAILED_EVENTS.has(event)
            ? 'bounced'
            : null;
      if (!outcome) continue;
      const moved = await this.deliveries
        .recordProviderOutcome(
          row,
          outcome,
          `resend:${emailId}:${event}`,
          `resend_${event} email_id=${emailId}`,
        )
        .catch(() => false);
      if (!moved) continue;
      if (outcome === 'delivered') out.delivered++;
      else {
        out.bounced++;
        this.logger.warn(
          `lead delivery ${row.id} ${event} at the mail provider; operator action needed`,
        );
      }
    }
    return out;
  }
}
