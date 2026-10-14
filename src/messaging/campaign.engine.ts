import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { FollowUpCampaign } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OutboxService } from '../integrations/core/outbox.service';
import { OutboxProcessorService } from '../integrations/core/outbox-processor.service';
import { MessagingService } from './messaging.service';
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
  ) {}

  onModuleInit() {
    this.processor.registerHandler('campaign.step', (p) =>
      this.execute(p as StepPayload),
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

  async execute(p: StepPayload) {
    const c = await this.prisma.followUpCampaign.findUnique({
      where: { id: p.campaignId },
    });
    if (!c || !c.enabled) return this.stop('campaign_disabled');
    if (c.version !== p.version) return this.stop('campaign_changed');
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
        select: { aiPaused: true },
      });
      if (conv?.aiPaused && policy.pauseOnHumanTakeover !== false)
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
