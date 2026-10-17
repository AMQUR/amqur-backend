import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { FollowUpCampaign } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OutboxService } from '../integrations/core/outbox.service';
import { OutboxProcessorService } from '../integrations/core/outbox-processor.service';
import { MessagingService } from './messaging.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { ConsentPurpose } from './consent.service';

/** Supported triggers. Each maps to an event emitted by authoritative business state. */
export const CAMPAIGN_TRIGGERS = {
  'appointment.confirmed.reminder': {
    purpose: 'TRANSACTIONAL',
    defaultDelay: 'beforeScheduled',
    subject: 'appointment',
  },
  'lead.no_response': {
    purpose: 'CONVERSATIONAL',
    defaultDelay: 'afterCreated',
    subject: 'lead',
  },
  'appointment.no_show': {
    purpose: 'CONVERSATIONAL',
    defaultDelay: 'afterEvent',
    subject: 'appointment',
  },
} as const;
export type CampaignTrigger = keyof typeof CAMPAIGN_TRIGGERS;

export type CampaignPolicy = {
  delayMinutes?: number;
  requireConsent?: true; // always enforced; field kept for display
  quietStart?: string;
  quietEnd?: string;
  maxPer24h?: number;
  pauseOnHumanTakeover?: boolean;
  stopOnCustomerReply?: boolean;
};

const ALLOWED_VARS = [
  'firstName',
  'dealerName',
  'appointmentDate',
  'appointmentTime',
  'vehicle',
] as const;

/** Only approved variables are substituted; unknown placeholders block the send (no invented facts). */
export function renderTemplate(
  template: string,
  vars: Partial<Record<(typeof ALLOWED_VARS)[number], string | null>>,
): string | null {
  let missing = false;
  const out = template.replace(/\{(\w+)\}/g, (_, k: string) => {
    if (!(ALLOWED_VARS as readonly string[]).includes(k)) {
      missing = true;
      return '';
    }
    const v = vars[k as (typeof ALLOWED_VARS)[number]];
    if (!v) {
      missing = true;
      return '';
    }
    return v;
  });
  return missing ? null : out.trim();
}

/**
 * Policy-controlled follow-up engine on the transactional outbox. Enrollment schedules a
 * delayed step; at execution time every stop condition is re-evaluated against current
 * authoritative state (opt-out, reply, staff takeover, lead closed, appointment changed,
 * campaign disabled/edited/expired). Score alone never triggers a message.
 */
@Injectable()
export class CampaignEngine implements OnModuleInit {
  private readonly logger = new Logger(CampaignEngine.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly processor: OutboxProcessorService,
    private readonly messaging: MessagingService,
    private readonly flags: FeatureFlagsService,
  ) {}

  onModuleInit() {
    this.processor.registerHandler('campaign.step', (p) =>
      this.execute(p as StepPayload),
    );
  }

  /** Tenant/location kill switch for ALL automated follow-up (in addition to per-campaign enable). */
  private async automationOn(tenantId: string, locationId?: string | null) {
    return (
      (await this.flags.resolve(tenantId, locationId)).automatedFollowup ===
      true
    );
  }

  async onEvent(e: {
    tenantId: string;
    locationId?: string | null;
    trigger: CampaignTrigger;
    subjectId: string;
    at?: Date;
    scheduledAt?: Date | null;
  }) {
    if (!(await this.automationOn(e.tenantId, e.locationId))) return;
    const campaigns = await this.prisma.followUpCampaign.findMany({
      where: {
        tenantId: e.tenantId,
        trigger: e.trigger,
        enabled: true,
        OR: [
          { locationId: null },
          ...(e.locationId ? [{ locationId: e.locationId }] : []),
        ],
      },
    });
    for (const c of campaigns) {
      const policy = (c.policy ?? {}) as CampaignPolicy;
      const base = e.at ?? new Date();
      const delay =
        (policy.delayMinutes ??
          (e.trigger === 'appointment.confirmed.reminder'
            ? -24 * 60
            : 24 * 60)) * 60_000;
      const runAt =
        e.trigger === 'appointment.confirmed.reminder' && e.scheduledAt
          ? new Date(e.scheduledAt.getTime() + delay)
          : new Date(base.getTime() + Math.abs(delay));
      if (runAt.getTime() < Date.now() - 60_000) continue; // reminder window already passed
      await this.outbox.enqueue({
        tenantId: e.tenantId,
        topic: 'campaign.step',
        idempotencyKey: `campaign:${c.id}:v${c.version}:${e.subjectId}`,
        availableAt: runAt,
        payload: {
          campaignId: c.id,
          version: c.version,
          subjectId: e.subjectId,
          enrolledAt: base.toISOString(),
        } satisfies StepPayload,
      });
    }
  }

  private async stop(reason: string) {
    this.logger.log(`campaign step stopped: ${reason}`);
    return { note: `stopped:${reason}` };
  }

  /**
   * Dry-run audience preview. Never queues or sends. Re-checks consent,
   * opt-out, closed leads, and appointment status against live records.
   */
  async previewAudience(
    tenantId: string,
    campaignId: string,
    opts?: { limit?: number },
  ) {
    const c = await this.prisma.followUpCampaign.findFirst({
      where: { id: campaignId, tenantId },
    });
    if (!c) return null;
    const limit = Math.min(Math.max(opts?.limit ?? 25, 1), 100);
    const meta = CAMPAIGN_TRIGGERS[c.trigger as CampaignTrigger];
    const automationEnabled = await this.automationOn(tenantId, c.locationId);
    const sample: Array<{
      subjectId: string;
      eligible: boolean;
      reason: string | null;
      maskedEndpoint: string | null;
    }> = [];
    let eligible = 0;
    let ineligible = 0;
    const reasons: Record<string, number> = {};

    if (!meta) {
      return {
        campaignId: c.id,
        trigger: c.trigger,
        channel: c.channel,
        enabled: c.enabled,
        automationEnabled,
        dryRun: true as const,
        wouldSend: false,
        totals: { candidates: 0, eligible: 0, ineligible: 0 },
        reasons: { invalid_trigger: 1 },
        sample: [],
        note: 'Preview only — no messages queued or sent.',
      };
    }

    const subjects = await this.candidateSubjects(c, 200);
    for (const id of subjects) {
      const ctx = await this.subject(c, id);
      let reason: string | null = null;
      let phone: string | null = null;
      if ('stop' in ctx) {
        reason = ctx.stop;
      } else {
        phone = ctx.phone;
        if (!phone) reason = 'no_endpoint';
        else if (ctx.conversationId) {
          const conv = await this.prisma.conversation.findUnique({
            where: { id: ctx.conversationId },
            select: { aiPaused: true, handoffState: true },
          });
          const policy = (c.policy ?? {}) as CampaignPolicy;
          if (
            policy.pauseOnHumanTakeover !== false &&
            conv &&
            (conv.aiPaused ||
              conv.handoffState === 'ASSIGNED' ||
              conv.handoffState === 'JOINED')
          )
            reason = 'human_owns_conversation';
        }
        if (!reason) {
          const consent = await this.messaging.previewConsent({
            tenantId,
            channel: 'SMS',
            to: phone!,
            purpose: meta.purpose as ConsentPurpose,
          });
          if (!consent.allowed) reason = consent.reason ?? 'consent_denied';
        }
      }
      if (!automationEnabled) reason = reason ?? 'automation_disabled';
      if (!c.enabled) reason = reason ?? 'campaign_disabled';

      const ok = !reason;
      if (ok) eligible++;
      else {
        ineligible++;
        reasons[reason!] = (reasons[reason!] ?? 0) + 1;
      }
      if (sample.length < limit) {
        sample.push({
          subjectId: id,
          eligible: ok,
          reason,
          maskedEndpoint: phone ? maskEndpoint(phone) : null,
        });
      }
    }

    return {
      campaignId: c.id,
      name: c.name,
      trigger: c.trigger,
      channel: c.channel,
      enabled: c.enabled,
      version: c.version,
      automationEnabled,
      dryRun: true as const,
      wouldSend: false,
      totals: {
        candidates: subjects.length,
        eligible,
        ineligible,
      },
      reasons,
      sample,
      note: 'Preview only — no messages queued or sent. Live send still requires enabled campaign, automatedFollowup flag, consent, and quiet-hours checks at delivery.',
    };
  }

  async stepAnalytics(tenantId: string, campaignId: string, days = 7) {
    const c = await this.prisma.followUpCampaign.findFirst({
      where: { id: campaignId, tenantId },
      select: { id: true, name: true, trigger: true },
    });
    if (!c) return null;
    const since = new Date(Date.now() - days * 86_400_000);
    const events = await this.prisma.analyticsEvent.findMany({
      where: {
        tenantId,
        eventType: {
          in: ['campaign.step_queued', 'campaign.step_suppressed'],
        },
        occurredAt: { gte: since },
      },
      select: { eventType: true, properties: true },
      take: 2000,
    });
    let queued = 0;
    let suppressed = 0;
    const suppressReasons: Record<string, number> = {};
    for (const e of events) {
      const props = (e.properties ?? {}) as {
        campaignId?: string;
        reason?: string | null;
      };
      if (props.campaignId !== campaignId) continue;
      if (e.eventType === 'campaign.step_queued') queued++;
      else {
        suppressed++;
        const r = props.reason ?? 'unknown';
        suppressReasons[r] = (suppressReasons[r] ?? 0) + 1;
      }
    }
    return {
      campaignId: c.id,
      name: c.name,
      trigger: c.trigger,
      windowDays: days,
      queued,
      suppressed,
      suppressReasons,
    };
  }

  private async candidateSubjects(
    c: FollowUpCampaign,
    take: number,
  ): Promise<string[]> {
    const loc =
      c.locationId != null ? { locationId: c.locationId } : {};
    if (c.trigger.startsWith('appointment.')) {
      const status =
        c.trigger === 'appointment.confirmed.reminder'
          ? 'CONFIRMED'
          : c.trigger === 'appointment.no_show'
            ? 'NO_SHOW'
            : undefined;
      const rows = await this.prisma.appointment.findMany({
        where: {
          tenantId: c.tenantId,
          ...loc,
          ...(status ? { status } : {}),
          scheduledAt:
            c.trigger === 'appointment.confirmed.reminder'
              ? { gt: new Date() }
              : undefined,
        },
        select: { id: true },
        orderBy: { updatedAt: 'desc' },
        take,
      });
      return rows.map((r) => r.id);
    }
    const rows = await this.prisma.lead.findMany({
      where: {
        tenantId: c.tenantId,
        ...loc,
        status: { in: ['OPEN', 'CONTACTED', 'QUALIFIED'] },
        phone: { not: null },
      },
      select: { id: true },
      orderBy: { updatedAt: 'desc' },
      take,
    });
    return rows.map((r) => r.id);
  }

  async execute(p: StepPayload) {
    const c = await this.prisma.followUpCampaign.findUnique({
      where: { id: p.campaignId },
    });
    if (!c || !c.enabled) return this.stop('campaign_disabled');
    if (c.version !== p.version) return this.stop('campaign_changed');
    if (!(await this.automationOn(c.tenantId, c.locationId)))
      return this.stop('automation_disabled');
    const now = new Date();
    if ((c.startsAt && c.startsAt > now) || (c.endsAt && c.endsAt < now))
      return this.stop('outside_window');
    const policy = (c.policy ?? {}) as CampaignPolicy;
    const meta = CAMPAIGN_TRIGGERS[c.trigger as CampaignTrigger];
    if (!meta || !c.template) return this.stop('invalid_campaign');
    const ctx = await this.subject(c, p.subjectId);
    if ('stop' in ctx) return this.stop(ctx.stop);
    if (ctx.conversationId) {
      const conv = await this.prisma.conversation.findUnique({
        where: { id: ctx.conversationId },
        select: { aiPaused: true, handoffState: true },
      });
      if (
        policy.pauseOnHumanTakeover !== false &&
        conv &&
        (conv.aiPaused ||
          conv.handoffState === 'ASSIGNED' ||
          conv.handoffState === 'JOINED')
      )
        return this.stop('human_owns_conversation');
      if (policy.stopOnCustomerReply !== false) {
        const replied = await this.prisma.message.count({
          where: {
            conversationId: ctx.conversationId,
            role: 'USER',
            createdAt: { gt: new Date(p.enrolledAt) },
          },
        });
        if (replied > 0) return this.stop('customer_replied');
      }
    }
    if (!ctx.phone) return this.stop('no_endpoint');
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: c.tenantId },
      select: { name: true },
    });
    const body = renderTemplate(c.template, {
      ...ctx.vars,
      dealerName: tenant?.name ?? null,
    });
    if (!body) return this.stop('template_variable_unavailable');
    const res = await this.messaging.queue({
      tenantId: c.tenantId,
      locationId: ctx.locationId,
      channel: 'SMS',
      to: ctx.phone,
      body: `${body} Reply STOP to opt out.`,
      purpose: meta.purpose as ConsentPurpose,
      conversationId: ctx.conversationId,
      leadId: ctx.leadId,
      campaignId: c.id,
      campaignVersion: c.version,
      idempotencyKey: `campaign:${c.id}:v${c.version}:${p.subjectId}`,
      policy,
    });
    await this.prisma.analyticsEvent
      .create({
        data: {
          tenantId: c.tenantId,
          locationId: ctx.locationId,
          eventType:
            res.status === 'QUEUED'
              ? 'campaign.step_queued'
              : 'campaign.step_suppressed',
          properties: {
            campaignId: c.id,
            version: c.version,
            trigger: c.trigger,
            reason: res.status === 'QUEUED' ? null : res.reason ?? null,
          },
        },
      })
      .catch(() => null);
    return {
      note: res.status === 'QUEUED' ? 'queued' : `suppressed:${res.reason}`,
    };
  }

  private async subject(
    c: FollowUpCampaign,
    id: string,
  ): Promise<SubjectCtx | { stop: string }> {
    if (c.trigger.startsWith('appointment.')) {
      const a = await this.prisma.appointment.findFirst({
        where: { id, tenantId: c.tenantId },
      });
      if (!a) return { stop: 'subject_missing' };
      if (
        c.trigger === 'appointment.confirmed.reminder' &&
        (a.status !== 'CONFIRMED' ||
          !a.scheduledAt ||
          a.scheduledAt < new Date())
      )
        return { stop: `appointment_${a.status.toLowerCase()}` };
      if (c.trigger === 'appointment.no_show' && a.status !== 'NO_SHOW')
        return { stop: 'no_longer_no_show' };
      const tz = a.timezone;
      return {
        conversationId: a.conversationId,
        leadId: a.leadId,
        locationId: a.locationId,
        phone: a.customerPhone,
        vars: {
          firstName: a.customerName?.split(' ')[0] ?? null,
          appointmentDate: a.scheduledAt
            ? a.scheduledAt.toLocaleDateString('en-US', {
                weekday: 'long',
                month: 'short',
                day: 'numeric',
                timeZone: tz,
              })
            : null,
          appointmentTime: a.scheduledAt
            ? a.scheduledAt.toLocaleTimeString('en-US', {
                hour: 'numeric',
                minute: '2-digit',
                timeZone: tz,
              })
            : null,
          vehicle: null,
        },
      };
    }
    const l = await this.prisma.lead.findFirst({
      where: { id, tenantId: c.tenantId },
    });
    if (!l) return { stop: 'subject_missing' };
    if (['CLOSED', 'CONVERTED', 'SPAM'].includes(l.status))
      return { stop: `lead_${l.status.toLowerCase()}` };
    return {
      conversationId: l.conversationId,
      leadId: l.id,
      locationId: l.locationId,
      phone: l.phone,
      vars: {
        firstName: l.firstName,
        vehicle: null,
        appointmentDate: null,
        appointmentTime: null,
      },
    };
  }
}

function maskEndpoint(phone: string): string {
  const d = phone.replace(/\D/g, '');
  if (d.length < 4) return '***';
  return `***${d.slice(-4)}`;
}

type StepPayload = {
  campaignId: string;
  version: number;
  subjectId: string;
  enrolledAt: string;
};
type SubjectCtx = {
  conversationId: string | null;
  leadId: string | null;
  locationId: string | null;
  phone: string | null;
  vars: Partial<Record<(typeof ALLOWED_VARS)[number], string | null>>;
};
