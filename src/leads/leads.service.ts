import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LeadStage, LeadStatus, Prisma } from '@prisma/client';

@Injectable()
export class LeadsService {
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

    const existing = conversationDbId
      ? await this.prisma.lead.findFirst({
          where: {
            tenantId: params.tenantId,
            conversationId: conversationDbId,
            status: { in: [LeadStatus.OPEN, LeadStatus.CONTACTED] },
          },
        })
      : params.email
        ? await this.prisma.lead.findFirst({
            where: {
              tenantId: params.tenantId,
              email: params.email.toLowerCase(),
              status: { in: [LeadStatus.OPEN, LeadStatus.CONTACTED] },
            },
          })
        : null;

    const data: Prisma.LeadUpdateInput = {
      firstName: params.firstName,
      lastName: params.lastName,
      phone: params.phone,
      email: params.email?.toLowerCase(),
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
        phone: params.phone,
        email: params.email?.toLowerCase(),
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
}
