import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const KINDS = [
  'SCHEDULE',
  'TRADE_INTAKE',
  'DOCUMENT_UPLOAD',
  'FINANCE_INFO',
  'CONTACT_UPDATE',
  'CUSTOM',
] as const;

export type ActionPageKind = (typeof KINDS)[number];

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class ActionPagesService {
  constructor(private readonly prisma: PrismaService) {}

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
    if (!token || token.length < 16) return { ok: false as const, reason: 'invalid' };
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
    await this.prisma.customerActionPage.update({
      where: { id: row.id },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        staffMeta: {
          ...((row.staffMeta as object) ?? {}),
          customerSubmission: safe,
          submittedAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
    });
    await this.prisma.analyticsEvent
      .create({
        data: {
          tenantId: row.tenantId,
          locationId: row.locationId,
          eventType: 'action_page.completed',
          properties: { kind: row.kind, pageId: row.id },
        },
      })
      .catch(() => null);
    return {
      ok: true as const,
      message:
        'Thanks — your request was saved. A team member will follow up. Nothing was confirmed or approved automatically.',
    };
  }
}
