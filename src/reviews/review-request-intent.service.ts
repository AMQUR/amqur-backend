import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ConsentService,
  normalizeEndpoint,
} from '../messaging/consent.service';
import { MessagingService } from '../messaging/messaging.service';

export const REVIEW_REQUEST_INTENT_ACTION = 'review_request.intent_pending';

export type ReviewRequestChannel = 'SMS' | 'EMAIL';

export type ReviewRequestIntentNotes = {
  csi: string;
  publicReview: string;
  sending: string;
};

export const REVIEW_REQUEST_INTENT_NOTES: ReviewRequestIntentNotes = {
  csi: 'Internal CSI (CustomerSurvey scores and comments) is private staff feedback for recovery — it never gates or triggers public review requests.',
  publicReview:
    'A review-request intent records staff intent to ask for a Google or other public review in person or via a future approved channel. This API never posts to Google.',
  sending:
    'No SMS or email is sent by this API. Outbound review asks remain manual or campaign-gated; mass SMS stays disabled until explicitly enabled elsewhere.',
};

type IntentMetadata = {
  status: 'PENDING';
  locationId: string | null;
  leadId: string | null;
  conversationId: string | null;
  surveyId: string | null;
  channel: ReviewRequestChannel;
  maskedEndpoint: string | null;
  eligible: boolean;
  blockedReasons: string[];
};

function maskEndpoint(raw: string): string {
  const d = raw.replace(/\D/g, '');
  if (d.length < 4) return '***';
  return `***${d.slice(-4)}`;
}

function asMetadata(v: unknown): IntentMetadata | null {
  if (!v || typeof v !== 'object') return null;
  const m = v as Record<string, unknown>;
  if (m.status !== 'PENDING') return null;
  return {
    status: 'PENDING',
    locationId: typeof m.locationId === 'string' ? m.locationId : null,
    leadId: typeof m.leadId === 'string' ? m.leadId : null,
    conversationId:
      typeof m.conversationId === 'string' ? m.conversationId : null,
    surveyId: typeof m.surveyId === 'string' ? m.surveyId : null,
    channel: m.channel === 'EMAIL' ? 'EMAIL' : 'SMS',
    maskedEndpoint:
      typeof m.maskedEndpoint === 'string' ? m.maskedEndpoint : null,
    eligible: m.eligible === true,
    blockedReasons: Array.isArray(m.blockedReasons)
      ? m.blockedReasons.filter((r): r is string => typeof r === 'string')
      : [],
  };
}

/**
 * Consent-aware public review request intents — audit-log backed, never auto-sends.
 * CSI survey scores are intentionally not read for eligibility.
 */
@Injectable()
export class ReviewRequestIntentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly consent: ConsentService,
    private readonly messaging: MessagingService,
  ) {}

  private parseChannel(channel?: string | null): ReviewRequestChannel {
    const c = (channel ?? 'SMS').toUpperCase();
    if (c !== 'SMS' && c !== 'EMAIL') {
      throw new BadRequestException('invalid_channel');
    }
    return c;
  }

  private async resolveSubject(
    tenantId: string,
    p: {
      leadId?: string | null;
      conversationId?: string | null;
      surveyId?: string | null;
      locationId?: string | null;
    },
  ) {
    let leadId = p.leadId ?? null;
    let conversationId = p.conversationId ?? null;
    let locationId = p.locationId ?? null;

    if (p.surveyId) {
      const survey = await this.prisma.customerSurvey.findFirst({
        where: { id: p.surveyId, tenantId },
        select: {
          id: true,
          leadId: true,
          conversationId: true,
          locationId: true,
        },
      });
      if (!survey) throw new BadRequestException('survey_not_in_tenant');
      leadId = leadId ?? survey.leadId;
      conversationId = conversationId ?? survey.conversationId;
      locationId = locationId ?? survey.locationId;
    }

    if (conversationId) {
      const conv = await this.prisma.conversation.findFirst({
        where: { id: conversationId, tenantId },
        select: { id: true, locationId: true },
      });
      if (!conv) throw new BadRequestException('conversation_not_in_tenant');
      locationId = locationId ?? conv.locationId;
    }

    let lead: {
      id: string;
      phone: string | null;
      email: string | null;
      optOutAt: Date | null;
      locationId: string | null;
      conversationId: string | null;
    } | null = null;

    if (leadId) {
      lead = await this.prisma.lead.findFirst({
        where: { id: leadId, tenantId },
        select: {
          id: true,
          phone: true,
          email: true,
          optOutAt: true,
          locationId: true,
          conversationId: true,
        },
      });
      if (!lead) throw new BadRequestException('lead_not_in_tenant');
      locationId = locationId ?? lead.locationId;
      conversationId = conversationId ?? lead.conversationId;
    } else if (conversationId) {
      lead = await this.prisma.lead.findFirst({
        where: { tenantId, conversationId },
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true,
          phone: true,
          email: true,
          optOutAt: true,
          locationId: true,
          conversationId: true,
        },
      });
      if (lead) {
        leadId = lead.id;
        locationId = locationId ?? lead.locationId;
      }
    }

    if (!leadId && !conversationId && !p.surveyId) {
      throw new BadRequestException('subject_required');
    }

    return {
      leadId,
      conversationId,
      surveyId: p.surveyId ?? null,
      locationId,
      lead,
    };
  }

  async checkEligibility(p: {
    tenantId: string;
    channel?: string | null;
    leadId?: string | null;
    conversationId?: string | null;
    surveyId?: string | null;
    locationId?: string | null;
  }) {
    const channel = this.parseChannel(p.channel);
    const subject = await this.resolveSubject(p.tenantId, p);
    const blockedReasons: string[] = [];
    const rawEndpoint =
      channel === 'SMS' ? subject.lead?.phone : subject.lead?.email;

    if (!subject.lead) {
      blockedReasons.push('no_lead');
    } else if (!rawEndpoint?.trim()) {
      blockedReasons.push('no_endpoint');
    }

    if (subject.lead?.optOutAt) {
      blockedReasons.push('lead_suppressed');
    }

    if (rawEndpoint?.trim()) {
      const normalized = normalizeEndpoint(
        channel === 'SMS' ? 'SMS' : 'EMAIL',
        rawEndpoint,
      );
      if (!normalized) {
        blockedReasons.push('invalid_endpoint');
      } else if (channel === 'EMAIL') {
        const emailConsent = await this.consent.status(
          p.tenantId,
          'EMAIL',
          rawEndpoint,
          'MARKETING',
        );
        if (!emailConsent.allowed) {
          blockedReasons.push(emailConsent.reason ?? 'no_consent');
        }
      } else {
        const smsConsent = await this.messaging.previewConsent({
          tenantId: p.tenantId,
          channel: 'SMS',
          to: rawEndpoint,
          purpose: 'MARKETING',
        });
        if (!smsConsent.allowed) {
          blockedReasons.push(smsConsent.reason ?? 'no_consent');
        }
      }
    }

    const eligible = blockedReasons.length === 0;
    const maskedEndpoint = rawEndpoint?.trim()
      ? maskEndpoint(rawEndpoint)
      : null;

    return {
      channel,
      leadId: subject.leadId,
      conversationId: subject.conversationId,
      surveyId: subject.surveyId,
      locationId: subject.locationId,
      maskedEndpoint,
      eligible,
      blockedReasons,
      notes: REVIEW_REQUEST_INTENT_NOTES,
      dryRun: true as const,
      willSend: false as const,
    };
  }

  async createPendingIntent(p: {
    tenantId: string;
    locationId?: string | null;
    leadId?: string | null;
    conversationId?: string | null;
    surveyId?: string | null;
    channel?: string | null;
    createdByUserId?: string | null;
  }) {
    const eligibility = await this.checkEligibility({
      tenantId: p.tenantId,
      channel: p.channel,
      leadId: p.leadId,
      conversationId: p.conversationId,
      surveyId: p.surveyId,
      locationId: p.locationId,
    });

    const metadata: IntentMetadata = {
      status: 'PENDING',
      locationId: eligibility.locationId ?? p.locationId ?? null,
      leadId: eligibility.leadId,
      conversationId: eligibility.conversationId,
      surveyId: eligibility.surveyId,
      channel: eligibility.channel,
      maskedEndpoint: eligibility.maskedEndpoint,
      eligible: eligibility.eligible,
      blockedReasons: eligibility.blockedReasons,
    };

    const row = await this.prisma.auditLog.create({
      data: {
        tenantId: p.tenantId,
        userId: p.createdByUserId ?? null,
        action: REVIEW_REQUEST_INTENT_ACTION,
        resource: 'ReviewRequestIntent',
        resourceId: null,
        metadata: metadata as unknown as Prisma.InputJsonValue,
      },
    });

    await this.prisma.auditLog.update({
      where: { id: row.id },
      data: { resourceId: row.id },
    });

    await this.prisma.analyticsEvent
      .create({
        data: {
          tenantId: p.tenantId,
          locationId: metadata.locationId,
          eventType: 'review_request.intent_pending',
          properties: {
            intentId: row.id,
            channel: metadata.channel,
            eligible: metadata.eligible,
            blockedReasons: metadata.blockedReasons,
            leadId: metadata.leadId,
            surveyId: metadata.surveyId,
          },
        },
      })
      .catch(() => undefined);

    return {
      id: row.id,
      createdAt: row.createdAt,
      ...metadata,
      status: 'PENDING' as const,
      notes: REVIEW_REQUEST_INTENT_NOTES,
      willSend: false as const,
    };
  }

  async listIntents(
    tenantId: string,
    opts?: { locationId?: string | null; take?: number },
  ) {
    const take = Math.min(opts?.take ?? 50, 100);
    const rows = await this.prisma.auditLog.findMany({
      where: { tenantId, action: REVIEW_REQUEST_INTENT_ACTION },
      orderBy: { createdAt: 'desc' },
      take: opts?.locationId ? take * 3 : take,
    });
    const mapped = rows
      .map((r) => {
        const meta = asMetadata(r.metadata);
        if (!meta) return null;
        return {
          id: r.resourceId ?? r.id,
          createdAt: r.createdAt,
          createdByUserId: r.userId,
          ...meta,
          status: meta.status,
          notes: REVIEW_REQUEST_INTENT_NOTES,
          willSend: false as const,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x != null);
    if (!opts?.locationId) return mapped.slice(0, take);
    return mapped
      .filter((m) => m.locationId === opts.locationId)
      .slice(0, take);
  }
}
