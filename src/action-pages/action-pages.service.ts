import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { AppointmentType, Prisma } from '@prisma/client';
import { AppointmentService } from '../appointments/appointment.service';
import { FinanceRequestService } from '../finance/finance-request.service';
import { PrismaService } from '../prisma/prisma.service';
import { TradeService } from '../trade/trade.service';
import { PartsInquiryService } from '../parts/parts-inquiry.service';
import { parseIsoDate } from '../common/time/zoned-time';

const KINDS = [
  'SCHEDULE',
  'TRADE_INTAKE',
  'PARTS_INTAKE',
  'DOCUMENT_UPLOAD',
  'FINANCE_INFO',
  'CONTACT_UPDATE',
  'CUSTOM',
] as const;

export type ActionPageKind = (typeof KINDS)[number];

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v.replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

@Injectable()
export class ActionPagesService {
  private readonly logger = new Logger(ActionPagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly appointments?: AppointmentService,
    @Optional() private readonly trade?: TradeService,
    @Optional() private readonly finance?: FinanceRequestService,
    @Optional() private readonly partsInquiry?: PartsInquiryService,
  ) {}

  async create(p: {
    tenantId: string;
    locationId?: string | null;
    leadId?: string | null;
    conversationId?: string | null;
    kind: string;
    title: string;
    description?: string | null;
    formSchema?: Record<string, unknown> | null;
    staffMeta?: Record<string, unknown> | null;
    expiresInHours?: number;
    createdByUserId?: string | null;
  }) {
    if (!(KINDS as readonly string[]).includes(p.kind))
      throw new BadRequestException('invalid_kind');
    if (p.leadId) {
      const lead = await this.prisma.lead.findFirst({
        where: { id: p.leadId, tenantId: p.tenantId },
        select: { id: true },
      });
      if (!lead) throw new BadRequestException('lead_not_in_tenant');
    }
    const raw = randomBytes(24).toString('base64url');
    const expiresAt =
      p.expiresInHours && p.expiresInHours > 0
        ? new Date(Date.now() + p.expiresInHours * 3600_000)
        : new Date(Date.now() + 14 * 86_400_000);
    const row = await this.prisma.customerActionPage.create({
      data: {
        tenantId: p.tenantId,
        locationId: p.locationId ?? null,
        leadId: p.leadId ?? null,
        conversationId: p.conversationId ?? null,
        kind: p.kind,
        title: p.title.slice(0, 120),
        description: p.description?.slice(0, 2000) ?? null,
        formSchema: (p.formSchema ?? undefined) as
          | Prisma.InputJsonValue
          | undefined,
        staffMeta: (p.staffMeta ?? undefined) as
          | Prisma.InputJsonValue
          | undefined,
        tokenHash: hashToken(raw),
        expiresAt,
        createdByUserId: p.createdByUserId ?? null,
      },
    });
    await this.prisma.auditLog.create({
      data: {
        tenantId: p.tenantId,
        userId: p.createdByUserId ?? null,
        action: 'action_page.create',
        resource: 'CustomerActionPage',
        resourceId: row.id,
        metadata: { kind: p.kind },
      },
    });
    // Raw token returned once — never stored.
    return { page: row, token: raw };
  }

  list(tenantId: string, opts?: { take?: number; status?: string }) {
    return this.prisma.customerActionPage.findMany({
      where: {
        tenantId,
        ...(opts?.status ? { status: opts.status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(opts?.take ?? 50, 100),
      select: {
        id: true,
        kind: true,
        title: true,
        status: true,
        leadId: true,
        locationId: true,
        expiresAt: true,
        completedAt: true,
        createdAt: true,
      },
    });
  }

  async revoke(tenantId: string, id: string, userId?: string) {
    const row = await this.prisma.customerActionPage.findFirst({
      where: { id, tenantId },
    });
    if (!row) throw new NotFoundException();
    const updated = await this.prisma.customerActionPage.update({
      where: { id },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    await this.prisma.auditLog.create({
      data: {
        tenantId,
        userId: userId ?? null,
        action: 'action_page.revoke',
        resource: 'CustomerActionPage',
        resourceId: id,
      },
    });
    return updated;
  }

  /** Public resolve — no staffMeta, no PII beyond title/description/form. */
  async resolvePublic(token: string) {
    if (!token || token.length < 16)
      return { ok: false as const, reason: 'invalid' };
    const row = await this.prisma.customerActionPage.findUnique({
      where: { tokenHash: hashToken(token) },
    });
    if (!row) return { ok: false as const, reason: 'not_found' };
    if (row.status === 'REVOKED')
      return { ok: false as const, reason: 'revoked' };
    if (row.status === 'COMPLETED')
      return { ok: false as const, reason: 'completed' };
    if (row.expiresAt && row.expiresAt < new Date()) {
      await this.prisma.customerActionPage
        .update({
          where: { id: row.id },
          data: { status: 'EXPIRED' },
        })
        .catch(() => null);
      return { ok: false as const, reason: 'expired' };
    }
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: row.tenantId },
      select: { name: true, slug: true },
    });
    return {
      ok: true as const,
      kind: row.kind,
      title: row.title,
      description: row.description,
      formSchema: row.formSchema,
      dealerName: tenant?.name ?? null,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      note: 'Submitting this page records your request for the dealership. It does not confirm appointments, prices, financing, or availability.',
    };
  }

  async completePublic(token: string, payload: Record<string, unknown>) {
    const resolved = await this.resolvePublic(token);
    if (!resolved.ok) return resolved;
    const row = await this.prisma.customerActionPage.findUnique({
      where: { tokenHash: hashToken(token) },
    });
    if (!row) return { ok: false as const, reason: 'not_found' };
    // Strip anything that looks like staff-only keys.
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload ?? {})) {
      if (/^(staff|internal|price|apr|approval)/i.test(k)) continue;
      if (typeof v === 'string') safe[k] = v.slice(0, 2000);
      else if (typeof v === 'number' || typeof v === 'boolean') safe[k] = v;
    }
    const domain = await this.routeSubmission(row, safe);
    await this.prisma.customerActionPage.update({
      where: { id: row.id },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        staffMeta: {
          ...((row.staffMeta as object) ?? {}),
          customerSubmission: safe,
          submittedAt: new Date().toISOString(),
          domainRouting: domain,
        } as Prisma.InputJsonValue,
      },
    });
    await this.prisma.analyticsEvent
      .create({
        data: {
          tenantId: row.tenantId,
          locationId: row.locationId,
          eventType: 'action_page.completed',
          properties: {
            kind: row.kind,
            pageId: row.id,
            domainRouted: domain.routed,
            domainRef: domain.ref ?? null,
          },
        },
      })
      .catch(() => null);
    return {
      ok: true as const,
      message:
        'Thanks — your request was saved. A team member will follow up. Nothing was confirmed or approved automatically.',
    };
  }

  /**
   * Fan submission into staff queues when enough verified fields exist.
   * Failures are recorded — never invent appointments, values, or approvals.
   */
  private async routeSubmission(
    row: {
      id: string;
      tenantId: string;
      locationId: string | null;
      conversationId: string | null;
      leadId: string | null;
      kind: string;
    },
    safe: Record<string, unknown>,
  ): Promise<{ routed: boolean; kind: string; ref?: string; reason?: string }> {
    try {
      if (row.kind === 'TRADE_INTAKE' && this.trade) {
        const created = await this.trade.createRequest({
          tenantId: row.tenantId,
          locationId: row.locationId,
          conversationId: row.conversationId,
          vin: asString(safe.vin),
          year: asNumber(safe.year),
          make: asString(safe.make),
          model: asString(safe.model),
          trim: asString(safe.trim),
          mileage: asNumber(safe.mileage),
          condition: asString(safe.condition),
          customerName: asString(safe.name) ?? asString(safe.customerName),
          customerPhone: asString(safe.phone) ?? asString(safe.customerPhone),
          customerEmail: asString(safe.email) ?? asString(safe.customerEmail),
          notes: asString(safe.notes),
        });
        return { routed: true, kind: row.kind, ref: created.id };
      }
      if (row.kind === 'PARTS_INTAKE' && this.partsInquiry) {
        const description =
          asString(safe.partDescription) ??
          asString(safe.description) ??
          asString(safe.partsDescription) ??
          asString(safe.suspectedPart) ??
          asString(safe.notes);
        if (!description) {
          return {
            routed: false,
            kind: row.kind,
            reason: 'missing_description',
          };
        }
        const installRaw = (
          asString(safe.installationRequested) ??
          asString(safe.install) ??
          ''
        ).toLowerCase();
        const preferredRaw = (
          asString(safe.preferredAction) ?? ''
        ).toUpperCase();
        const preferredAction = (
          ['INFO', 'QUOTE', 'RESERVE', 'ORDER', 'INSTALL'] as const
        ).includes(preferredRaw as 'INFO')
          ? (preferredRaw as 'INFO' | 'QUOTE' | 'RESERVE' | 'ORDER' | 'INSTALL')
          : installRaw === 'yes' || installRaw === 'true'
            ? 'INSTALL'
            : null;
        const created = await this.partsInquiry.upsertFromActionPage({
          tenantId: row.tenantId,
          locationId: row.locationId,
          conversationId: row.conversationId,
          actionPageId: row.id,
          description,
          partNumber: asString(safe.partNumber),
          suspectedPart:
            asString(safe.suspectedPart) ?? asString(safe.partName),
          vin: asString(safe.vin),
          vehicle: {
            year: asNumber(safe.year) ?? undefined,
            make: asString(safe.make) ?? undefined,
            model: asString(safe.model) ?? undefined,
          },
          preferredAction,
          installationRequested:
            safe.installationRequested === true ||
            installRaw === 'yes' ||
            installRaw === 'true' ||
            preferredAction === 'INSTALL',
          customer: {
            name: asString(safe.name) ?? asString(safe.customerName),
            phone: asString(safe.phone) ?? asString(safe.customerPhone),
            email: asString(safe.email) ?? asString(safe.customerEmail),
          },
        });
        return { routed: true, kind: row.kind, ref: created.id };
      }
      if (row.kind === 'FINANCE_INFO' && this.finance) {
        const created = await this.finance.create({
          tenantId: row.tenantId,
          locationId: row.locationId,
          conversationId: row.conversationId,
          vehicleVin: asString(safe.vin),
          desiredPayment: asNumber(safe.desiredPayment),
          downPayment: asNumber(safe.downPayment),
          termMonths: asNumber(safe.termMonths),
          leaseOrPurchase: asString(safe.leaseOrPurchase),
          tradeInterest:
            safe.tradeInterest === true ||
            asString(safe.tradeInterest)?.toLowerCase() === 'yes',
          customerName: asString(safe.name) ?? asString(safe.customerName),
          customerPhone: asString(safe.phone) ?? asString(safe.customerPhone),
          customerEmail: asString(safe.email) ?? asString(safe.customerEmail),
          notes: asString(safe.notes),
        });
        return { routed: true, kind: row.kind, ref: created.id };
      }
      if (row.kind === 'SCHEDULE' && this.appointments) {
        const dateRaw = asString(safe.date) ?? asString(safe.requestedDate);
        const date = dateRaw ? parseIsoDate(dateRaw) : null;
        if (!date) {
          return {
            routed: false,
            kind: row.kind,
            reason: 'missing_date',
          };
        }
        const typeRaw = (asString(safe.type) ?? 'SALES').toUpperCase();
        const type = (
          ['SALES', 'SERVICE', 'PARTS', 'FINANCE', 'TEST_DRIVE'].includes(
            typeRaw,
          )
            ? typeRaw
            : 'SALES'
        ) as AppointmentType;
        const timeRaw = asString(safe.time) ?? asString(safe.requestedTime);
        let timeMinutes: number | undefined;
        if (timeRaw && /^\d{1,2}:\d{2}/.test(timeRaw)) {
          const [hh, mm] = timeRaw.split(':').map((x) => Number(x));
          if (Number.isFinite(hh) && Number.isFinite(mm))
            timeMinutes = hh * 60 + mm;
        }
        const podRaw = (
          asString(safe.partOfDay) ??
          asString(safe.when) ??
          ''
        ).toLowerCase();
        const partOfDay = (
          ['morning', 'afternoon', 'evening'] as const
        ).includes(podRaw as 'morning')
          ? (podRaw as 'morning' | 'afternoon' | 'evening')
          : undefined;
        const result = await this.appointments.request({
          tenantId: row.tenantId,
          locationId: row.locationId,
          conversationId: row.conversationId,
          leadId: row.leadId,
          type,
          when: {
            date,
            time: timeMinutes,
            partOfDay,
            phrase: asString(safe.phrase) ?? 'action_page',
          },
          vin: asString(safe.vin),
          serviceType: asString(safe.serviceType),
          customer: {
            name:
              asString(safe.name) ?? asString(safe.customerName) ?? undefined,
            phone:
              asString(safe.phone) ?? asString(safe.customerPhone) ?? undefined,
            email:
              asString(safe.email) ?? asString(safe.customerEmail) ?? undefined,
          },
          source: 'api',
          notes: `action_page:${row.id}`,
          idempotencyKey: `action_page:${row.id}`,
        });
        if (result.status === 'saved') {
          return {
            routed: true,
            kind: row.kind,
            ref: result.appointment.id,
          };
        }
        return {
          routed: false,
          kind: row.kind,
          reason:
            result.status === 'incomplete'
              ? `incomplete_${result.missing}`
              : result.status,
        };
      }
      if (row.kind === 'CONTACT_UPDATE' && row.leadId) {
        const phone = asString(safe.phone) ?? asString(safe.customerPhone);
        const email = asString(safe.email) ?? asString(safe.customerEmail);
        const firstName = asString(safe.firstName) ?? asString(safe.name);
        await this.prisma.lead.updateMany({
          where: { id: row.leadId, tenantId: row.tenantId },
          data: {
            ...(phone ? { phone } : {}),
            ...(email ? { email } : {}),
            ...(firstName ? { firstName } : {}),
            ...(asString(safe.lastName)
              ? { lastName: asString(safe.lastName)! }
              : {}),
          },
        });
        return { routed: true, kind: row.kind, ref: row.leadId };
      }
      return { routed: false, kind: row.kind, reason: 'no_domain_route' };
    } catch (e) {
      this.logger.warn(
        `action page domain route failed page=${row.id} kind=${row.kind}: ${
          e instanceof Error ? e.message : 'error'
        }`,
      );
      return {
        routed: false,
        kind: row.kind,
        reason: 'domain_route_error',
      };
    }
  }
}
