import { BadRequestException, Injectable } from '@nestjs/common';
import {
  CustomerSurveyFollowUpStatus,
  CustomerSurveyKind,
  CustomerSurveyStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const CHANNELS = ['SMS', 'EMAIL', 'LINK', 'IN_PERSON'] as const;
const KINDS = ['SALES', 'SERVICE'] as const;

/** Scores at or below this open a manager recovery queue (internal CSI only). */
const FOLLOW_UP_SCORE_THRESHOLD = 6;

const COMPLAINT_HINT =
  /\b(angry|upset|terrible|awful|complaint|lawsuit|attorney|never again|worst|refund)\b/i;

/**
 * Internal CSI drafts and manager recovery. Creating a draft never sends SMS/email.
 * Not an OEM manufacturer CSI instrument.
 */
@Injectable()
export class CustomerSurveyService {
  constructor(private readonly prisma: PrismaService) {}

  private parseKind(kind?: string | null): CustomerSurveyKind {
    const k = (kind ?? 'SALES').toUpperCase();
    if (!(KINDS as readonly string[]).includes(k)) {
      throw new BadRequestException('invalid_kind');
    }
    return k as CustomerSurveyKind;
  }

  async createDraft(p: {
    tenantId: string;
    locationId?: string | null;
    leadId?: string | null;
    conversationId?: string | null;
    appointmentId?: string | null;
    kind?: string;
    templateId?: string | null;
    channel?: string;
    createdByUserId?: string | null;
    metadata?: Record<string, unknown> | null;
  }) {
    const channel = (p.channel ?? 'LINK').toUpperCase();
    if (!(CHANNELS as readonly string[]).includes(channel)) {
      throw new BadRequestException('invalid_channel');
    }
    const kind = this.parseKind(p.kind);
    if (p.leadId) {
      const lead = await this.prisma.lead.findFirst({
        where: { id: p.leadId, tenantId: p.tenantId },
        select: { id: true },
      });
      if (!lead) throw new BadRequestException('lead_not_in_tenant');
    }
    if (p.templateId) {
      const tpl = await this.prisma.customerSurveyTemplate.findFirst({
        where: {
          id: p.templateId,
          tenantId: p.tenantId,
          active: true,
        },
        select: { id: true, kind: true, defaultChannel: true },
      });
      if (!tpl) throw new BadRequestException('template_not_found');
      if (tpl.kind !== kind) throw new BadRequestException('template_kind_mismatch');
    }
    const row = await this.prisma.customerSurvey.create({
      data: {
        tenantId: p.tenantId,
        locationId: p.locationId ?? null,
        leadId: p.leadId ?? null,
        conversationId: p.conversationId ?? null,
        appointmentId: p.appointmentId ?? null,
        kind,
        templateId: p.templateId ?? null,
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
          metadata: {
            channel,
            kind,
            leadId: p.leadId ?? null,
            templateId: p.templateId ?? null,
          },
        },
      })
      .catch(() => undefined);
    return row;
  }

  list(
    tenantId: string,
    opts?: {
      locationId?: string | null;
      status?: CustomerSurveyStatus;
      kind?: CustomerSurveyKind | string;
      take?: number;
    },
  ) {
    const kind = opts?.kind ? this.parseKind(String(opts.kind)) : undefined;
    return this.prisma.customerSurvey.findMany({
      where: {
        tenantId,
        ...(opts?.locationId ? { locationId: opts.locationId } : {}),
        ...(opts?.status ? { status: opts.status } : {}),
        ...(kind ? { kind } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(opts?.take ?? 50, 100),
      include: {
        template: { select: { id: true, name: true, kind: true } },
      },
    });
  }

  listFollowUps(
    tenantId: string,
    opts?: { locationId?: string | null; take?: number },
  ) {
    return this.prisma.customerSurvey.findMany({
      where: {
        tenantId,
        ...(opts?.locationId ? { locationId: opts.locationId } : {}),
        followUpStatus: {
          in: [
            CustomerSurveyFollowUpStatus.PENDING,
            CustomerSurveyFollowUpStatus.ACKNOWLEDGED,
          ],
        },
      },
      orderBy: [{ followUpAt: 'asc' }, { respondedAt: 'asc' }],
      take: Math.min(opts?.take ?? 50, 100),
      include: {
        template: { select: { id: true, name: true, kind: true } },
      },
    });
  }

  /**
   * Staff-recorded response (in-person / phone CSI). Does not send outbound messages.
   * Low scores or complaint language open a manager recovery queue.
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
    const comment = p.comment?.slice(0, 2000) ?? null;
    const needsFollowUp =
      p.score <= FOLLOW_UP_SCORE_THRESHOLD ||
      (comment != null && COMPLAINT_HINT.test(comment));
    const updated = await this.prisma.customerSurvey.update({
      where: { id: existing.id },
      data: {
        status: CustomerSurveyStatus.RESPONDED,
        score: p.score,
        comment,
        respondedAt: new Date(),
        followUpRequired: needsFollowUp,
        followUpStatus: needsFollowUp
          ? CustomerSurveyFollowUpStatus.PENDING
          : CustomerSurveyFollowUpStatus.NONE,
        followUpAt: needsFollowUp ? new Date() : null,
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
          metadata: {
            score: p.score,
            followUpRequired: needsFollowUp,
            kind: updated.kind,
          },
        },
      })
      .catch(() => undefined);
    if (needsFollowUp) {
      await this.prisma.analyticsEvent
        .create({
          data: {
            tenantId: p.tenantId,
            locationId: updated.locationId,
            eventType: 'csi.follow_up_queued',
            properties: {
              surveyId: updated.id,
              score: p.score,
              kind: updated.kind,
            },
          },
        })
        .catch(() => null);
    }
    return updated;
  }

  async acknowledgeFollowUp(p: {
    tenantId: string;
    surveyId: string;
    actorUserId: string;
  }) {
    const existing = await this.prisma.customerSurvey.findFirst({
      where: {
        id: p.surveyId,
        tenantId: p.tenantId,
        followUpStatus: CustomerSurveyFollowUpStatus.PENDING,
      },
    });
    if (!existing) throw new BadRequestException('follow_up_not_pending');
    return this.prisma.customerSurvey.update({
      where: { id: existing.id },
      data: {
        followUpStatus: CustomerSurveyFollowUpStatus.ACKNOWLEDGED,
        assignedManagerUserId: p.actorUserId,
      },
    });
  }

  async resolveFollowUp(p: {
    tenantId: string;
    surveyId: string;
    actorUserId: string;
    managerNote?: string | null;
  }) {
    const existing = await this.prisma.customerSurvey.findFirst({
      where: {
        id: p.surveyId,
        tenantId: p.tenantId,
        followUpStatus: {
          in: [
            CustomerSurveyFollowUpStatus.PENDING,
            CustomerSurveyFollowUpStatus.ACKNOWLEDGED,
          ],
        },
      },
    });
    if (!existing) throw new BadRequestException('follow_up_not_open');
    const updated = await this.prisma.customerSurvey.update({
      where: { id: existing.id },
      data: {
        followUpStatus: CustomerSurveyFollowUpStatus.RESOLVED,
        assignedManagerUserId:
          existing.assignedManagerUserId ?? p.actorUserId,
        managerNote: p.managerNote?.slice(0, 2000) ?? existing.managerNote,
      },
    });
    await this.prisma.auditLog
      .create({
        data: {
          tenantId: p.tenantId,
          userId: p.actorUserId,
          action: 'customer_survey.follow_up_resolved',
          resource: 'CustomerSurvey',
          resourceId: updated.id,
        },
      })
      .catch(() => undefined);
    return updated;
  }

  listTemplates(
    tenantId: string,
    opts?: { kind?: string; locationId?: string | null },
  ) {
    const kind = opts?.kind ? this.parseKind(opts.kind) : undefined;
    return this.prisma.customerSurveyTemplate.findMany({
      where: {
        tenantId,
        active: true,
        ...(kind ? { kind } : {}),
        ...(opts?.locationId
          ? { OR: [{ locationId: opts.locationId }, { locationId: null }] }
          : {}),
      },
      orderBy: { name: 'asc' },
      take: 100,
    });
  }

  async createTemplate(p: {
    tenantId: string;
    locationId?: string | null;
    kind?: string;
    name: string;
    scriptBody: string;
    defaultChannel?: string;
    createdByUserId?: string | null;
  }) {
    const kind = this.parseKind(p.kind);
    const channel = (p.defaultChannel ?? 'IN_PERSON').toUpperCase();
    if (!(CHANNELS as readonly string[]).includes(channel)) {
      throw new BadRequestException('invalid_channel');
    }
    const name = p.name.trim().slice(0, 80);
    const scriptBody = p.scriptBody.trim().slice(0, 4000);
    if (name.length < 2) throw new BadRequestException('name_too_short');
    if (scriptBody.length < 10)
      throw new BadRequestException('script_too_short');
    return this.prisma.customerSurveyTemplate.create({
      data: {
        tenantId: p.tenantId,
        locationId: p.locationId ?? null,
        kind,
        name,
        scriptBody,
        defaultChannel: channel,
        createdByUserId: p.createdByUserId ?? null,
      },
    });
  }

  async rollup(
    tenantId: string,
    opts?: { locationId?: string | null; days?: number; kind?: string },
  ) {
    const since = new Date(Date.now() - (opts?.days ?? 30) * 86_400_000);
    const kind = opts?.kind ? this.parseKind(opts.kind) : undefined;
    const base = {
      tenantId,
      ...(opts?.locationId ? { locationId: opts.locationId } : {}),
      ...(kind ? { kind } : {}),
    };
    const [drafts, responded, followUpsPending, salesAvg, serviceAvg] =
      await Promise.all([
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
          select: { score: true, kind: true },
          take: 2000,
        }),
        this.prisma.customerSurvey.count({
          where: {
            tenantId,
            ...(opts?.locationId ? { locationId: opts.locationId } : {}),
            followUpStatus: {
              in: [
                CustomerSurveyFollowUpStatus.PENDING,
                CustomerSurveyFollowUpStatus.ACKNOWLEDGED,
              ],
            },
          },
        }),
        this.avgForKind(tenantId, CustomerSurveyKind.SALES, since, opts?.locationId),
        this.avgForKind(
          tenantId,
          CustomerSurveyKind.SERVICE,
          since,
          opts?.locationId,
        ),
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
      respondedCount: values.length,
      averageScore: average,
      followUpsOpen: followUpsPending,
      byKind: {
        sales: salesAvg,
        service: serviceAvg,
      },
      note: 'Internal staff-recorded CSI only — not an OEM manufacturer survey. Mass SMS survey send is not enabled.',
    };
  }

  private async avgForKind(
    tenantId: string,
    kind: CustomerSurveyKind,
    since: Date,
    locationId?: string | null,
  ) {
    const rows = await this.prisma.customerSurvey.findMany({
      where: {
        tenantId,
        kind,
        ...(locationId ? { locationId } : {}),
        status: CustomerSurveyStatus.RESPONDED,
        respondedAt: { gte: since },
        score: { not: null },
      },
      select: { score: true },
      take: 2000,
    });
    const values = rows
      .map((r) => r.score)
      .filter((s): s is number => typeof s === 'number');
    return {
      count: values.length,
      average:
        values.length > 0
          ? Math.round(
              (values.reduce((a, b) => a + b, 0) / values.length) * 10,
            ) / 10
          : null,
    };
  }
}
