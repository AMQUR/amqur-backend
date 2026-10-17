import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const KINDS = ['VEHICLE', 'OFFER', 'EVENT', 'ANNOUNCEMENT'] as const;
const MANAGER = new Set(['SUPER_ADMIN', 'ADMIN', 'MANAGER']);
const SCARCITY =
  /\b(only \d+ left|won'?t last|act (?:now|fast)|hurry|last chance|selling fast|limited time only)\b/i;

export type SpotlightInput = {
  kind: (typeof KINDS)[number];
  title: string;
  body: string;
  linkUrl?: string | null;
  vehicleVin?: string | null;
  source?: string | null;
  disclaimer?: string | null;
  startsAt: string;
  endsAt: string;
};

/**
 * Dealer-managed spotlights with a two-person flow: staff draft, a manager approves.
 * Validation refuses manufactured urgency, non-HTTPS/off-site links, offers without a source
 * and disclaimer, and VEHICLE spotlights whose VIN is not in this store's live inventory.
 */
@Injectable()
export class SpotlightsService {
  constructor(private readonly prisma: PrismaService) {}

  private async validate(
    tenantId: string,
    locationId: string,
    i: SpotlightInput,
  ) {
    if (!KINDS.includes(i.kind)) throw new BadRequestException('Unknown kind');
    if (!i.title?.trim() || i.title.length > 80)
      throw new BadRequestException('title 1–80 chars');
    if (!i.body?.trim() || i.body.length > 400)
      throw new BadRequestException('body 1–400 chars');
    if (SCARCITY.test(`${i.title} ${i.body}`))
      throw new BadRequestException(
        'Manufactured urgency/scarcity wording is not allowed',
      );
    const s = new Date(i.startsAt);
    const e = new Date(i.endsAt);
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e <= s)
      throw new BadRequestException('endsAt must be after startsAt');
    if (e.getTime() - s.getTime() > 120 * 86_400_000)
      throw new BadRequestException('Max 120 days');
    if (i.linkUrl) {
      let u: URL;
      try {
        u = new URL(i.linkUrl);
      } catch {
        throw new BadRequestException('Invalid link');
      }
      const t = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { allowedOrigins: true },
      });
      const origins = (t?.allowedOrigins ?? '')
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean);
      if (u.protocol !== 'https:' || !origins.includes(u.origin))
        throw new BadRequestException(
          'Link must be HTTPS on the dealership’s own website',
        );
    }
    if (i.kind === 'OFFER' && (!i.source?.trim() || !i.disclaimer?.trim()))
      throw new BadRequestException('Offers need a source and a disclaimer');
    if (i.kind === 'VEHICLE') {
      if (!i.vehicleVin)
        throw new BadRequestException('Vehicle spotlight needs a VIN');
      const v = await this.prisma.vehicle.findFirst({
        where: {
          tenantId,
          vin: i.vehicleVin.toUpperCase(),
          status: { in: ['AVAILABLE', 'IN_TRANSIT'] },
          OR: [{ locationId }, { locationId: null }],
          ...(process.env.NODE_ENV === 'production'
            ? { NOT: { source: 'synthetic_demo' } }
            : {}),
        },
        select: { id: true },
      });
      if (!v)
        throw new BadRequestException(
          'VIN is not in this store’s available inventory',
        );
    }
    return { s, e };
  }

  async create(
    tenantId: string,
    locationId: string,
    userId: string,
    i: SpotlightInput,
  ) {
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, tenantId },
      select: { id: true },
    });
    if (!loc) throw new NotFoundException('Location not found');
    const { s, e } = await this.validate(tenantId, locationId, i);
    const row = await this.prisma.spotlight.create({
      data: {
        tenantId,
        locationId,
        kind: i.kind,
        title: i.title.trim(),
        body: i.body.trim(),
        linkUrl: i.linkUrl ?? null,
        vehicleVin: i.vehicleVin?.toUpperCase() ?? null,
        source: i.source ?? null,
        disclaimer: i.disclaimer ?? null,
        status: 'PENDING_APPROVAL',
        startsAt: s,
        endsAt: e,
        createdById: userId,
      },
    });
    await this.prisma.auditLog
      .create({
        data: {
          tenantId,
          userId,
          action: 'spotlight.created',
          resource: 'Spotlight',
          resourceId: row.id,
          metadata: {
            kind: row.kind,
            title: row.title,
            locationId,
            status: row.status,
          } as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);
    return row;
  }

  async decide(
    tenantId: string,
    user: { id: string; role: string },
    id: string,
    approve: boolean,
  ) {
    if (!MANAGER.has(user.role))
      throw new ForbiddenException('Only managers approve spotlights');
    const sp = await this.prisma.spotlight.findFirst({
      where: { id, tenantId },
    });
    if (!sp) throw new NotFoundException();
    if (approve && sp.createdById === user.id && user.role !== 'SUPER_ADMIN')
      throw new ForbiddenException(
        'A different manager must approve (two-person rule)',
      );
    const row = await this.prisma.spotlight.update({
      where: { id },
      data: approve
        ? { status: 'APPROVED', approvedById: user.id, approvedAt: new Date() }
        : { status: 'REJECTED' },
    });
    await this.prisma.auditLog.create({
      data: {
        tenantId,
        userId: user.id,
        action: approve ? 'spotlight.approved' : 'spotlight.rejected',
        resource: 'Spotlight',
        resourceId: id,
        metadata: { title: sp.title } as Prisma.InputJsonValue,
      },
    });
    return row;
  }

  async archive(tenantId: string, id: string, userId: string) {
    const existing = await this.prisma.spotlight.findFirst({
      where: { id, tenantId },
      select: { id: true, title: true, status: true },
    });
    if (!existing) throw new NotFoundException();
    await this.prisma.spotlight.update({
      where: { id },
      data: { status: 'ARCHIVED' },
    });
    await this.prisma.auditLog
      .create({
        data: {
          tenantId,
          userId,
          action: 'spotlight.archived',
          resource: 'Spotlight',
          resourceId: id,
          metadata: {
            title: existing.title,
            fromStatus: existing.status,
          } as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);
    return { archived: true };
  }

  list(tenantId: string, locationId?: string | null) {
    return this.prisma.spotlight.findMany({
      where: { tenantId, ...(locationId ? { locationId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  /** Customer-visible: approved, in window, this store only; vehicle spotlights re-checked against live stock. */
  async activeForStore(tenantId: string, locationId: string, now = new Date()) {
    const rows = await this.prisma.spotlight.findMany({
      where: {
        tenantId,
        locationId,
        status: 'APPROVED',
        startsAt: { lte: now },
        endsAt: { gt: now },
      },
      orderBy: { startsAt: 'desc' },
      take: 3,
    });
    const out: Array<Record<string, unknown>> = [];
    for (const r of rows) {
      if (r.vehicleVin) {
        const ok = await this.prisma.vehicle.count({
          where: {
            tenantId,
            vin: r.vehicleVin,
            status: { in: ['AVAILABLE', 'IN_TRANSIT'] },
            ...(process.env.NODE_ENV === 'production'
              ? { NOT: { source: 'synthetic_demo' } }
              : {}),
          },
        });
        if (!ok) continue; // sold/removed → never advertise it
      }
      out.push({
        id: r.id,
        kind: r.kind,
        title: r.title,
        body: r.body,
        linkUrl: r.linkUrl,
        vehicleVin: r.vehicleVin,
        disclaimer: r.disclaimer,
        endsAt: r.endsAt.toISOString(),
        label: 'Dealership announcement',
      });
    }
    return out;
  }
}
