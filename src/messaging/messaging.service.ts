import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SecretVaultService } from '../integrations/core/secret-vault.service';
import { OutboxService } from '../integrations/core/outbox.service';
import {
  OutboxProcessorService,
  PermanentOutboxError,
} from '../integrations/core/outbox-processor.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { MetricsService } from '../observability/metrics.service';
import {
  ConsentPurpose,
  ConsentService,
  normalizeEndpoint,
} from './consent.service';
import { TwilioCredentials, twilioSendSms } from './twilio';
import { fromZoned, toZoned, isValidTimeZone } from '../common/time/zoned-time';

export type QueueResult =
  | { status: 'QUEUED'; id: string; deferredUntil?: string }
  | { status: 'SUPPRESSED'; id?: string; reason: string };

/**
 * Outbound messaging with consent, quiet hours and frequency caps enforced on enqueue AND
 * re-checked at send time. "Sent"/"delivered" states come only from the provider; a queued
 * message is never described to a customer or staff member as delivered.
 */
@Injectable()
export class MessagingService implements OnModuleInit {
  private readonly logger = new Logger(MessagingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly vault: SecretVaultService,
    private readonly outbox: OutboxService,
    private readonly processor: OutboxProcessorService,
    private readonly flags: FeatureFlagsService,
    private readonly consent: ConsentService,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit() {
    this.processor.registerHandler('messaging.send', (p) =>
      this.deliver(String(p.outboundMessageId)),
    );
  }

  /**
   * Consent-only dry-run check for campaign audience preview.
   * Does not inspect provider credentials or enqueue anything.
   */
  async previewConsent(p: {
    tenantId: string;
    channel: 'SMS';
    to: string;
    purpose: ConsentPurpose;
  }): Promise<{ allowed: boolean; reason?: string }> {
    const c = await this.consent.status(
      p.tenantId,
      p.channel,
      p.to,
      p.purpose,
    );
    return c.allowed
      ? { allowed: true }
      : { allowed: false, reason: c.reason };
  }

  /** Per-tenant Twilio credentials from the vault; null unless explicitly enabled + live-ready. */
  async twilioCredentials(
    tenantId: string,
    locationId?: string | null,
  ): Promise<TwilioCredentials | null> {
    const conn = await this.prisma.integrationConnection.findFirst({
      where: {
        tenantId,
        provider: 'TWILIO',
        capability: 'messaging',
        enabled: true,
        liveReady: true,
        OR: locationId
          ? [{ locationId }, { locationId: null }]
          : [{ locationId: null }],
      },
      include: { secrets: true },
      orderBy: { updatedAt: 'desc' },
    });
    if (!conn || !this.vault.isReady()) return null;
    const get = (k: string) => {
      const s = conn.secrets.find((x) => x.keyName === k);
      return s ? this.vault.decrypt(s) : null;
    };
    const accountSid = get('accountSid');
    const authToken = get('authToken');
    const messagingServiceSid = get('messagingServiceSid');
    return accountSid && authToken && messagingServiceSid
      ? { accountSid, authToken, messagingServiceSid }
      : null;
  }

  private async quietHours(
    tenantId: string,
    locationId: string | null | undefined,
    policy?: { quietStart?: string; quietEnd?: string },
  ) {
    const loc = locationId
      ? await this.prisma.location.findFirst({
          where: { id: locationId, tenantId },
          select: { timezone: true, messagingPolicy: true },
        })
      : null;
    const tz =
      loc && isValidTimeZone(loc.timezone) ? loc.timezone : 'America/Chicago';
    const locPolicy =
      loc?.messagingPolicy && typeof loc.messagingPolicy === 'object'
        ? (loc.messagingPolicy as { quietStart?: string; quietEnd?: string })
        : {};
    const startStr = policy?.quietStart ?? locPolicy.quietStart ?? '21:00';
    const endStr = policy?.quietEnd ?? locPolicy.quietEnd ?? '08:00';
    const [sh, sm] = startStr.split(':').map(Number);
    const [eh, em] = endStr.split(':').map(Number);
    return { tz, start: sh * 60 + (sm || 0), end: eh * 60 + (em || 0) };
  }

  /** If `now` is inside quiet hours (dealership tz), returns the next allowed instant. */
  static nextAllowed(
    now: Date,
    q: { tz: string; start: number; end: number },
  ): Date | null {
    const z = toZoned(now, q.tz);
    const mins = z.hour * 60 + z.minute;
    const inQuiet =
      q.start > q.end
        ? mins >= q.start || mins < q.end
        : mins >= q.start && mins < q.end;
    if (!inQuiet) return null;
    const day =
      mins >= q.start && q.start > q.end
        ? { year: z.year, month: z.month, day: z.day + 1 }
        : { year: z.year, month: z.month, day: z.day };
    const d = new Date(Date.UTC(day.year, day.month - 1, day.day));
    return fromZoned(
      {
        year: d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        day: d.getUTCDate(),
        hour: Math.floor(q.end / 60),
        minute: q.end % 60,
      },
      q.tz,
    );
  }

  async queue(p: {
    tenantId: string;
    locationId?: string | null;
    channel: 'SMS';
    to: string;
    body: string;
    purpose: ConsentPurpose;
    conversationId?: string | null;
    leadId?: string | null;
    campaignId?: string | null;
    campaignVersion?: number | null;
    idempotencyKey?: string;
    policy?: { quietStart?: string; quietEnd?: string; maxPer24h?: number };
    now?: Date;
  }): Promise<QueueResult> {
    const now = p.now ?? new Date();
    const endpoint = normalizeEndpoint('SMS', p.to);
    const suppress = async (reason: string): Promise<QueueResult> => {
      this.metrics.increment(`messaging.suppressed.${reason}`);
      if (!endpoint) return { status: 'SUPPRESSED', reason };
      const row = await this.prisma.outboundMessage.create({
        data: {
          tenantId: p.tenantId,
          locationId: p.locationId ?? null,
          conversationId: p.conversationId ?? null,
          leadId: p.leadId ?? null,
          campaignId: p.campaignId ?? null,
          campaignVersion: p.campaignVersion ?? null,
          channel: p.channel,
          endpoint,
          purpose: p.purpose,
          body: p.body.slice(0, 1600),
          status: 'SUPPRESSED',
          suppressReason: reason,
          idempotencyKey: p.idempotencyKey
            ? `${p.idempotencyKey}:suppressed:${now.getTime()}`
            : null,
        },
      });
      return { status: 'SUPPRESSED', id: row.id, reason };
    };
    if (!endpoint) return suppress('invalid_endpoint');
    const f = await this.flags.resolve(p.tenantId, p.locationId);
    if (f.sms !== true) return suppress('sms_disabled');
    if (!(await this.twilioCredentials(p.tenantId, p.locationId)))
      return suppress('provider_not_configured');
    const c = await this.consent.status(p.tenantId, 'SMS', endpoint, p.purpose);
    if (!c.allowed) return suppress(c.reason);
    const cap = p.policy?.maxPer24h ?? (p.purpose === 'MARKETING' ? 1 : 4);
    const recent = await this.prisma.outboundMessage.count({
      where: {
        tenantId: p.tenantId,
        channel: 'SMS',
        endpoint,
        status: { in: ['QUEUED', 'SENT', 'DELIVERED'] },
        createdAt: { gte: new Date(now.getTime() - 86_400_000) },
      },
    });
    if (recent >= cap) return suppress('frequency_cap');
    const quiet = await this.quietHours(p.tenantId, p.locationId, p.policy);
    const deferred = MessagingService.nextAllowed(now, quiet);
    if (p.idempotencyKey) {
      const existing = await this.prisma.outboundMessage.findUnique({
        where: {
          tenantId_idempotencyKey: {
            tenantId: p.tenantId,
            idempotencyKey: p.idempotencyKey,
          },
        },
      });
      if (existing) {
        if (existing.status === 'QUEUED') {
          return {
            status: 'QUEUED',
            id: existing.id,
            ...(deferred ? { deferredUntil: deferred.toISOString() } : {}),
          };
        }
        // Already processed under this key — do not enqueue a second send.
        return {
          status: 'SUPPRESSED',
          id: existing.id,
          reason: `duplicate_idempotency:${existing.status.toLowerCase()}`,
        };
      }
    }
    let row: { id: string };
    try {
      row = await this.prisma.$transaction(async (tx) => {
        const m = await tx.outboundMessage.create({
          data: {
            tenantId: p.tenantId,
            locationId: p.locationId ?? null,
            conversationId: p.conversationId ?? null,
            leadId: p.leadId ?? null,
            campaignId: p.campaignId ?? null,
            campaignVersion: p.campaignVersion ?? null,
            channel: 'SMS',
            endpoint,
            purpose: p.purpose,
            body: p.body.slice(0, 1600),
            status: 'QUEUED',
            provider: 'TWILIO',
            idempotencyKey: p.idempotencyKey ?? null,
          },
        });
        await this.outbox.enqueue({
          tenantId: p.tenantId,
          topic: 'messaging.send',
          idempotencyKey: `msg:${m.id}`,
          payload: { outboundMessageId: m.id },
          tx,
          availableAt: deferred ?? undefined,
        });
        return m;
      });
    } catch (e: unknown) {
      if (
        p.idempotencyKey &&
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const winner = await this.prisma.outboundMessage.findUnique({
          where: {
            tenantId_idempotencyKey: {
              tenantId: p.tenantId,
              idempotencyKey: p.idempotencyKey,
            },
          },
        });
        if (winner?.status === 'QUEUED') {
          return {
            status: 'QUEUED',
            id: winner.id,
            ...(deferred ? { deferredUntil: deferred.toISOString() } : {}),
          };
        }
      }
      throw e;
    }
    this.metrics.increment('messaging.queued');
    return {
      status: 'QUEUED',
      id: row.id,
      ...(deferred ? { deferredUntil: deferred.toISOString() } : {}),
    };
  }

  /** Outbox handler: re-check consent, ownership, quiet hours at send time. */
  private async deliver(id: string) {
    const m = await this.prisma.outboundMessage.findUnique({ where: { id } });
    if (!m) throw new PermanentOutboxError('message_not_found');
    if (m.status !== 'QUEUED')
      return { note: `already_${m.status.toLowerCase()}` };
    const c = await this.consent.status(
      m.tenantId,
      'SMS',
      m.endpoint,
      m.purpose as ConsentPurpose,
    );
    if (!c.allowed) {
      await this.prisma.outboundMessage.update({
        where: { id },
        data: { status: 'SUPPRESSED', suppressReason: `at_send:${c.reason}` },
      });
      return { note: 'suppressed_at_send' };
    }
    // Human ownership: never deliver an automated SMS while staff owns the thread.
    if (m.conversationId) {
      const conv = await this.prisma.conversation.findFirst({
        where: { id: m.conversationId, tenantId: m.tenantId },
        select: { aiPaused: true, handoffState: true },
      });
      if (
        conv &&
        (conv.aiPaused ||
          conv.handoffState === 'ASSIGNED' ||
          conv.handoffState === 'JOINED')
      ) {
        await this.prisma.outboundMessage.update({
          where: { id },
          data: {
            status: 'SUPPRESSED',
            suppressReason: 'at_send:human_owns_thread',
          },
        });
        this.metrics.increment('messaging.suppressed.human_owns_thread');
        return { note: 'suppressed_human_owns_thread' };
      }
    }
    // Quiet hours re-check (DST-safe). Marketing/campaigns must not slip through
    // if the outbox fired early or the store timezone shifted.
    if (m.purpose === 'MARKETING' || m.campaignId) {
      const quiet = await this.quietHours(m.tenantId, m.locationId);
      const deferred = MessagingService.nextAllowed(new Date(), quiet);
      if (deferred) {
        await this.outbox.enqueue({
          tenantId: m.tenantId,
          topic: 'messaging.send',
          idempotencyKey: `msg:${m.id}:quiet:${deferred.toISOString()}`,
          payload: { outboundMessageId: m.id },
          availableAt: deferred,
        });
        this.metrics.increment('messaging.deferred_at_send');
        return { note: 'deferred_quiet_hours', until: deferred.toISOString() };
      }
    }
    const creds = await this.twilioCredentials(m.tenantId, m.locationId);
    if (!creds) {
      await this.prisma.outboundMessage.update({
        where: { id },
        data: {
          status: 'SUPPRESSED',
          suppressReason: 'provider_not_configured',
        },
      });
      return { note: 'provider_not_configured' };
    }
    const base = (
      process.env.PUBLIC_API_URL || process.env.PUBLIC_API_BASE_URL
    )?.replace(/\/$/, '');
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: m.tenantId },
      select: { slug: true },
    });
    const res = await twilioSendSms(creds, {
      to: m.endpoint,
      body: m.body,
      statusCallback:
        base && tenant
          ? `${base}/api/webhooks/twilio/${tenant.slug}/status`
          : undefined,
    });
    if (res.ok) {
      await this.prisma.outboundMessage.update({
        where: { id },
        data: {
          status: 'SENT',
          providerMessageId: res.providerMessageId,
          error: null,
        },
      });
      this.metrics.increment('messaging.sent');
      return;
    }
    if (res.optedOut) {
      await this.consent.record({
        tenantId: m.tenantId,
        channel: 'SMS',
        endpoint: m.endpoint,
        purpose: 'CONVERSATIONAL',
        granted: false,
        source: 'PROVIDER',
        evidence: { error: res.error },
      });
      await this.prisma.outboundMessage.update({
        where: { id },
        data: {
          status: 'SUPPRESSED',
          suppressReason: 'provider_opted_out',
          error: res.error,
        },
      });
      return;
    }
    await this.prisma.outboundMessage.update({
      where: { id },
      data: { error: res.error },
    });
    if (res.retryable) throw new Error(res.error);
    await this.prisma.outboundMessage.update({
      where: { id },
      data: { status: 'FAILED' },
    });
    throw new PermanentOutboxError(res.error);
  }
}
