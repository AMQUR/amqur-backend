import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LeadStage, LeadStatus, Prisma } from '@prisma/client';
import {
  normalizeEmail,
  normalizePhone,
  pickUniqueMatch,
} from './contact-identity';

@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);
  constructor(private readonly prisma: PrismaService) {}

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

    let existing =
      conversationDbId
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

    return this.prisma.lead.create({
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
      },
    });
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
      return this.prisma.lead.update({ where: { id: existing.id }, data });
    }
    return this.prisma.lead.create({
      data: {
        ...data,
        tenantId: p.tenantId,
        locationId: p.locationId ?? null,
        conversationId: p.conversationId,
        source: p.source ?? 'widget',
        status: LeadStatus.OPEN,
      },
    });
  }
}
