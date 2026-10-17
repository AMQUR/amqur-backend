import { BadRequestException, Injectable } from '@nestjs/common';
import { CustomerSurveyStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const CHANNELS = ['SMS', 'EMAIL', 'LINK', 'IN_PERSON'] as const;

/**
 * Internal CSI drafts. Creating a draft never sends SMS/email.
 * Recording a response requires an explicit staff/API call with a score.
 */
@Injectable()
export class CustomerSurveyService {
  constructor(private readonly prisma: PrismaService) {}

  async createDraft(p: {
    tenantId: string;
    locationId?: string | null;
    leadId?: string | null;
    conversationId?: string | null;
    channel?: string;
    createdByUserId?: string | null;
    metadata?: Record<string, unknown> | null;
  }) {
    const channel = (p.channel ?? 'LINK').toUpperCase();
    if (!(CHANNELS as readonly string[]).includes(channel)) {
      throw new BadRequestException('invalid_channel');
    }
    if (p.leadId) {
      const lead = await this.prisma.lead.findFirst({
        where: { id: p.leadId, tenantId: p.tenantId },
        select: { id: true },
      });
      if (!lead) throw new BadRequestException('lead_not_in_tenant');
    }
    const row = await this.prisma.customerSurvey.create({
      data: {
        tenantId: p.tenantId,
        locationId: p.locationId ?? null,
        leadId: p.leadId ?? null,
        conversationId: p.conversationId ?? null,
        channel,
        status: CustomerSurveyStatus.DRAFT,
        createdByUserId: p.createdByUserId ?? null,
        metadata: (p.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
    await this.prisma.auditLog
      .create({
        data: {
          tenantId: p.tenantId,
          userId: p.createdByUserId ?? null,
          action: 'customer_survey.create_draft',
          resource: 'CustomerSurvey',
          resourceId: row.id,
          metadata: { channel, leadId: p.leadId ?? null },
        },
      })
      .catch(() => undefined);
    return row;
  }

  list(
    tenantId: string,
    opts?: { locationId?: string | null; status?: CustomerSurveyStatus; take?: number },
  ) {
    return this.prisma.customerSurvey.findMany({
      where: {
        tenantId,
        ...(opts?.locationId ? { locationId: opts.locationId } : {}),
        ...(opts?.status ? { status: opts.status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(opts?.take ?? 50, 100),
    });
  }

  /**
   * Staff-recorded response (in-person / phone CSI). Does not send outbound messages.
   */
  async recordResponse(p: {
    tenantId: string;
    surveyId: string;
    score: number;
    comment?: string | null;
    actorUserId?: string | null;
  }) {
    if (!Number.isInteger(p.score) || p.score < 1 || p.score > 10) {
      throw new BadRequestException('score_must_be_1_to_10');
    }
    const existing = await this.prisma.customerSurvey.findFirst({
      where: { id: p.surveyId, tenantId: p.tenantId },
    });
    if (!existing) throw new BadRequestException('survey_not_found');
    if (existing.status === CustomerSurveyStatus.CANCELLED) {
      throw new BadRequestException('survey_cancelled');
    }
    const updated = await this.prisma.customerSurvey.update({
      where: { id: existing.id },
      data: {
        status: CustomerSurveyStatus.RESPONDED,
        score: p.score,
        comment: p.comment?.slice(0, 2000) ?? null,
        respondedAt: new Date(),
      },
    });
    await this.prisma.auditLog
      .create({
        data: {
          tenantId: p.tenantId,
          userId: p.actorUserId ?? null,
          action: 'customer_survey.record_response',
          resource: 'CustomerSurvey',
          resourceId: updated.id,
          metadata: { score: p.score },
        },
      })
      .catch(() => undefined);
    return updated;
  }

  async rollup(
    tenantId: string,
    opts?: { locationId?: string | null; days?: number },
  ) {
    const since = new Date(Date.now() - (opts?.days ?? 30) * 86_400_000);
    const base = {
      tenantId,
      ...(opts?.locationId ? { locationId: opts.locationId } : {}),
    };
    const [drafts, responded, scores] = await Promise.all([
      this.prisma.customerSurvey.count({
        where: { ...base, status: CustomerSurveyStatus.DRAFT },
      }),
      this.prisma.customerSurvey.findMany({
        where: {
          ...base,
          status: CustomerSurveyStatus.RESPONDED,
          respondedAt: { gte: since },
          score: { not: null },
        },
        select: { score: true },
        take: 2000,
      }),
      this.prisma.customerSurvey.count({
        where: {
          ...base,
          status: CustomerSurveyStatus.RESPONDED,
          respondedAt: { gte: since },
        },
      }),
    ]);
    const values = responded
      .map((r) => r.score)
      .filter((s): s is number => typeof s === 'number');
    const average =
      values.length > 0
        ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) /
          10
        : null;
    return {
      windowDays: opts?.days ?? 30,
      draftsOpen: drafts,
      respondedCount: scores,
      averageScore: average,
      note: 'Scores are staff-recorded CSI only. Mass SMS survey send is not enabled from this API.',
    };
  }
}
