import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { LeadStage, LeadStatus, Prisma } from '@prisma/client';
import {
  normalizeEmail,
  normalizePhone,
  pickUniqueMatch,
} from './contact-identity';
import {
  assignableStaffWhere,
  resolveNewLeadAssignee,
} from './round-robin';

@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: FeatureFlagsService,
  ) {}

  /** Manual assign / unassign — validated against tenant + lead rooftop; audited. */
  async assignManual(
    tenantId: string,
    locationScope: string | null,
    leadId: string,
    actorUserId: string,
    assignedUserId: string | null,
  ) {
    const lead = await this.prisma.lead.findFirst({
      where: {
        id: leadId,
        tenantId,
        ...(locationScope ? { locationId: locationScope } : {}),
      },
      select: {
        id: true,
        locationId: true,
        assignedUserId: true,
        conversationId: true,
      },
    });
    if (!lead) throw new NotFoundException('Lead not found');

    const next = assignedUserId?.trim() ? assignedUserId.trim() : null;
    if (next) {
      const assignee = await this.prisma.user.findFirst({
        where: {
          id: next,
          ...assignableStaffWhere(tenantId, lead.locationId),
        },
        select: { id: true },
      });
      if (!assignee) {
        throw new BadRequestException(
          'Assignee must be an active staff or manager for this rooftop',
        );
      }
    }

    if (lead.assignedUserId === next) {
      return this.prisma.lead.findUniqueOrThrow({
        where: { id: lead.id },
        include: {
          location: {
            select: { id: true, name: true, slug: true },
          },
          conversation: {
            select: {
              id: true,
              externalKey: true,
              lastActivityAt: true,
              channel: true,
            },
          },
        },
      });
    }

    const updated = await this.prisma.lead.update({
      where: { id: lead.id },
      data: { assignedUserId: next },
      include: {
        location: {
          select: { id: true, name: true, slug: true },
        },
        conversation: {
          select: {
            id: true,
            externalKey: true,
            lastActivityAt: true,
            channel: true,
          },
        },
      },
    });

    await this.syncConversationAssignee(lead.conversationId, next);

    await this.prisma.auditLog
      .create({
        data: {
          tenantId,
          userId: actorUserId,
          action: 'lead.assign',
          resource: 'Lead',
          resourceId: lead.id,
          metadata: {
            fromUserId: lead.assignedUserId,
            toUserId: next,
            locationId: lead.locationId,
          },
        },
      })
      .catch(() => undefined);

    return updated;
  }

  /**
   * Keep Inbox "Mine" (conversation.assignedUserId) aligned with lead ownership.
   * Does not pause AI or change handoff — takeover remains explicit.
   */
  private async syncConversationAssignee(
    conversationId: string | null | undefined,
    assignedUserId: string | null,
  ) {
    if (!conversationId) return;
    await this.prisma.conversation
      .updateMany({
        where: { id: conversationId },
        data: { assignedUserId },
      })
      .catch(() => undefined);
  }

  list(tenantId: string, opts?: { status?: LeadStatus; take?: number }) {
    return this.prisma.lead.findMany({
      where: {
        tenantId,
        ...(opts?.status ? { status: opts.status } : {}),
      },
      include: {
        location: {
          select: { id: true, name: true, slug: true },
        },
        conversation: {
          select: {
            id: true,
            externalKey: true,
            lastActivityAt: true,
            channel: true,
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: Math.min(opts?.take ?? 50, 200),
    });
  }

  async upsertFromConversation(params: {
    tenantId: string;
    locationId?: string | null;
    conversationId?: string | null;
    externalKey: string;
    firstName?: string;
    lastName?: string;
    phone?: string;
    email?: string;
    interestedVin?: string;
    score?: number;
    stage?: 'cold' | 'warm' | 'hot';
    consentToText?: boolean;
    preferredContact?: string;
  }) {
    const stageMap: Record<string, LeadStage> = {
      cold: LeadStage.COLD,
      warm: LeadStage.WARM,
      hot: LeadStage.HOT,
    };

    let conversationDbId = params.conversationId ?? null;
    if (!conversationDbId) {
      const conv = await this.prisma.conversation.findUnique({
        where: {
          tenantId_externalKey: {
            tenantId: params.tenantId,
            externalKey: params.externalKey,
          },
        },
        select: { id: true },
      });
      conversationDbId = conv?.id ?? null;
    }

    const email = normalizeEmail(params.email);
    const phone = normalizePhone(params.phone);

    let existing = conversationDbId
      ? await this.prisma.lead.findFirst({
          where: {
            tenantId: params.tenantId,
            conversationId: conversationDbId,
            status: { in: [LeadStatus.OPEN, LeadStatus.CONTACTED] },
          },
        })
      : null;

    if (!existing && (email || phone)) {
      const candidates = await this.prisma.lead.findMany({
        where: {
          tenantId: params.tenantId,
          status: { in: [LeadStatus.OPEN, LeadStatus.CONTACTED] },
          OR: [
            ...(email ? [{ email }] : []),
            ...(phone
              ? [
                  { phone },
                  // legacy unnormalized rows that end with the same 10 digits
                  ...(phone.length >= 12
                    ? [{ phone: { endsWith: phone.slice(-10) } }]
                    : []),
                ]
              : []),
          ],
        },
        take: 5,
      });
      const pick = pickUniqueMatch(candidates);
      if (pick.status === 'MATCHED') existing = pick.lead;
      if (pick.status === 'AMBIGUOUS') {
        this.logger.warn(
          `ambiguous lead match tenant=${params.tenantId} ids=${pick.ids.join(',')}`,
        );
        // Do not merge — create a new open lead for human review.
        existing = null;
      }
    }

    const data: Prisma.LeadUpdateInput = {
      firstName: params.firstName,
      lastName: params.lastName,
      phone: phone ?? params.phone,
      email: email ?? undefined,
      interestedVin: params.interestedVin,
      score: params.score ?? 0,
      stage: stageMap[params.stage ?? 'cold'] ?? LeadStage.COLD,
      consentToText: params.consentToText ?? false,
      preferredContact: params.preferredContact,
      location: params.locationId
        ? { connect: { id: params.locationId } }
        : undefined,
    };

    if (existing) {
      return this.prisma.lead.update({
        where: { id: existing.id },
        data,
      });
    }

    const flags = await this.flags.resolve(params.tenantId, params.locationId);
    const assignedUserId = await resolveNewLeadAssignee(this.prisma, flags, {
      tenantId: params.tenantId,
      locationId: params.locationId,
    });

    const created = await this.prisma.lead.create({
      data: {
        tenantId: params.tenantId,
        locationId: params.locationId ?? null,
        conversationId: conversationDbId,
        firstName: params.firstName,
        lastName: params.lastName,
        phone: phone ?? params.phone,
        email: email,
        interestedVin: params.interestedVin,
        score: params.score ?? 0,
        stage: stageMap[params.stage ?? 'cold'] ?? LeadStage.COLD,
        consentToText: params.consentToText ?? false,
        preferredContact: params.preferredContact,
        source: 'widget',
        status: LeadStatus.OPEN,
        assignedUserId,
      },
    });
    if (assignedUserId) {
      await this.syncConversationAssignee(conversationDbId, assignedUserId);
    }
    return created;
  }

  /**
   * Journey-aware lead upsert (critical write — callers await). Populates only fields the
   * customer actually provided; never overwrites known values with blanks.
   */
  async upsertJourneyLead(p: {
    tenantId: string;
    locationId?: string | null;
    conversationId: string;
    firstName?: string;
    lastName?: string;
    phone?: string;
    email?: string;
    interestedVin?: string;
    interestedStock?: string;
    budget?: number;
    desiredPayment?: number;
    financingNeeded?: boolean;
    leaseVsPurchase?: string;
    tradeInInterest?: boolean;
    purchaseTimeline?: string;
    languagePreference?: string;
    preferredContact?: string;
    consentToText?: boolean;
    consentToEmail?: boolean;
    utmSource?: string;
    utmMedium?: string;
    utmCampaign?: string;
    source?: string;
    score: number;
    stage: 'cold' | 'warm' | 'hot';
    scoreReasons: unknown;
    scoreVersion: string;
    nextBestAction?: string;
  }) {
    const stage = {
      cold: LeadStage.COLD,
      warm: LeadStage.WARM,
      hot: LeadStage.HOT,
    }[p.stage];
    const set = <T>(v: T | undefined | null) =>
      v === undefined || v === null || v === '' ? undefined : v;
    const data = {
      firstName: set(p.firstName),
      lastName: set(p.lastName),
      phone: set(p.phone),
      email: set(p.email?.toLowerCase()),
      interestedVin: set(p.interestedVin),
      interestedStock: set(p.interestedStock),
      budget: set(p.budget),
      desiredPayment: set(p.desiredPayment),
      financingNeeded: set(p.financingNeeded),
      leaseVsPurchase: set(p.leaseVsPurchase),
      tradeInInterest: set(p.tradeInInterest),
      purchaseTimeline: set(p.purchaseTimeline),
      languagePreference: set(p.languagePreference),
      preferredContact: set(p.preferredContact),
      consentToText: set(p.consentToText),
      consentToEmail: set(p.consentToEmail),
      utmSource: set(p.utmSource),
      utmMedium: set(p.utmMedium),
      utmCampaign: set(p.utmCampaign),
      score: p.score,
      stage,
      scoreReasons: p.scoreReasons as Prisma.InputJsonValue,
      scoreVersion: p.scoreVersion,
      nextBestAction: set(p.nextBestAction),
    };
    const status = resolveLeadStatus({
      score: p.score,
      stage: p.stage,
      phone: p.phone,
      email: p.email,
      interestedVin: p.interestedVin,
      financingNeeded: p.financingNeeded,
      tradeInInterest: p.tradeInInterest,
    });
    const existing = await this.prisma.lead.findFirst({
      where: {
        tenantId: p.tenantId,
        conversationId: p.conversationId,
        status: {
          in: [LeadStatus.OPEN, LeadStatus.CONTACTED, LeadStatus.QUALIFIED],
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      // Never demote QUALIFIED → OPEN; only advance.
      const nextStatus =
        rankStatus(status) > rankStatus(existing.status)
          ? status
          : existing.status;
      return this.prisma.lead.update({
        where: { id: existing.id },
        data: { ...data, status: nextStatus },
      });
    }
    const flags = await this.flags.resolve(p.tenantId, p.locationId);
    const assignedUserId = await resolveNewLeadAssignee(this.prisma, flags, {
      tenantId: p.tenantId,
      locationId: p.locationId,
    });
    const created = await this.prisma.lead.create({
      data: {
        ...data,
        tenantId: p.tenantId,
        locationId: p.locationId ?? null,
        conversationId: p.conversationId,
        source: p.source ?? 'widget',
        status,
        assignedUserId,
      },
    });
    if (assignedUserId) {
      await this.syncConversationAssignee(p.conversationId, assignedUserId);
    }
    return created;
  }

  /**
   * Meta Lead Ads materialization — only verified Graph / webhook ids and field_data.
   * Idempotent on metaLeadgenId (same as WebhookInbox.externalEventId). No CRM writeback.
   */
  async upsertFromMetaLeadgen(p: {
    tenantId: string;
    leadgenId: string;
    webhookInboxId: string;
    firstName?: string;
    lastName?: string;
    phone?: string;
    email?: string;
    zipCode?: string;
    metaContext?: {
      pageId?: string;
      formId?: string;
      adId?: string;
      adgroupId?: string;
      graphLeadId?: string;
    };
    needsStaffReview: boolean;
  }) {
    const email = normalizeEmail(p.email);
    const phone = normalizePhone(p.phone);
    const scoreReasons = {
      metaLeadgenId: p.leadgenId,
      webhookInboxId: p.webhookInboxId,
      needsStaffReview: p.needsStaffReview,
      metaContext: p.metaContext ?? {},
    };

    const existing = await this.prisma.lead.findFirst({
      where: {
        tenantId: p.tenantId,
        scoreReasons: {
          path: ['metaLeadgenId'],
          equals: p.leadgenId,
        },
      },
    });
    if (existing) {
      return { lead: existing, created: false as const };
    }

    const set = <T>(v: T | undefined | null) =>
      v === undefined || v === null || v === '' ? undefined : v;

    const data = {
      firstName: set(p.firstName),
      lastName: set(p.lastName),
      phone: phone ?? undefined,
      email: email ?? undefined,
      zipCode: set(p.zipCode),
      scoreReasons: scoreReasons as Prisma.InputJsonValue,
      scoreVersion: 'meta_leadgen_v1',
      source: 'meta_leadgen',
      utmSource: 'meta',
      utmMedium: 'lead_ad',
      utmCampaign: p.metaContext?.adId?.slice(0, 120),
      notes: p.needsStaffReview
        ? 'Meta Lead Ads: staff review required (incomplete lead fields or Graph fetch unavailable).'
        : undefined,
    };

    const status = resolveLeadStatus({
      score: 0,
      stage: 'cold',
      phone: phone ?? undefined,
      email: email ?? undefined,
    });

    const flags = await this.flags.resolve(p.tenantId, null);
    const assignedUserId = await resolveNewLeadAssignee(this.prisma, flags, {
      tenantId: p.tenantId,
      locationId: null,
    });

    const lead = await this.prisma.lead.create({
      data: {
        tenantId: p.tenantId,
        ...data,
        score: 0,
        stage: LeadStage.COLD,
        status,
        assignedUserId,
      },
    });
    return { lead, created: true as const };
  }

  async findByMetaLeadgenId(tenantId: string, leadgenId: string) {
    return this.prisma.lead.findFirst({
      where: {
        tenantId,
        scoreReasons: {
          path: ['metaLeadgenId'],
          equals: leadgenId,
        },
      },
    });
  }
}

/** Promote open leads toward QUALIFIED from real signals — never invent CRM outcomes. */
export function resolveLeadStatus(p: {
  score: number;
  stage: 'cold' | 'warm' | 'hot';
  phone?: string | null;
  email?: string | null;
  interestedVin?: string | null;
  financingNeeded?: boolean | null;
  tradeInInterest?: boolean | null;
}): LeadStatus {
  const hasContact = !!(p.phone || p.email);
  if (!hasContact) return LeadStatus.OPEN;
  const qualified =
    p.stage === 'hot' ||
    p.score >= 12 ||
    (!!p.interestedVin && p.score >= 6) ||
    (!!p.financingNeeded && hasContact) ||
    (!!p.tradeInInterest && hasContact && p.score >= 8);
  if (qualified) return LeadStatus.QUALIFIED;
  return LeadStatus.CONTACTED;
}

function rankStatus(s: LeadStatus | string): number {
  if (s === LeadStatus.QUALIFIED || s === 'QUALIFIED') return 3;
  if (s === LeadStatus.CONTACTED || s === 'CONTACTED') return 2;
  if (s === LeadStatus.OPEN || s === 'OPEN') return 1;
  return 0;
}
