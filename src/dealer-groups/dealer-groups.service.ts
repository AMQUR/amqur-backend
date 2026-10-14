import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DealerGroupRole } from '@prisma/client';

/**
 * Group-level reporting only. Never returns another tenant's PII/leads/vehicles
 * without an explicit DealerGroupMembership check.
 */
@Injectable()
export class DealerGroupsService {
  constructor(private readonly prisma: PrismaService) {}

  async assertMembership(
    userId: string,
    dealerGroupId: string,
    minRole: DealerGroupRole = DealerGroupRole.GROUP_VIEWER,
  ) {
    const membership = await this.prisma.dealerGroupMembership.findUnique({
      where: {
        dealerGroupId_userId: { dealerGroupId, userId },
      },
    });
    if (!membership) {
      throw new ForbiddenException('GROUP_ACCESS_DENIED');
    }
    if (
      minRole === DealerGroupRole.GROUP_ADMIN &&
      membership.role !== DealerGroupRole.GROUP_ADMIN
    ) {
      throw new ForbiddenException('GROUP_ADMIN_REQUIRED');
    }
    return membership;
  }

  async listForUser(userId: string, isSuperAdmin: boolean) {
    if (isSuperAdmin) {
      return this.prisma.dealerGroup.findMany({
        select: {
          id: true,
          slug: true,
          name: true,
          _count: { select: { tenants: true } },
        },
        orderBy: { name: 'asc' },
      });
    }
    const memberships = await this.prisma.dealerGroupMembership.findMany({
      where: { userId },
      include: {
        dealerGroup: {
          select: {
            id: true,
            slug: true,
            name: true,
            _count: { select: { tenants: true } },
          },
        },
      },
    });
    return memberships.map((m) => ({
      ...m.dealerGroup,
      membershipRole: m.role,
    }));
  }

  /**
   * Aggregate counts only — no lead/vehicle/conversation payloads.
   * Requires GROUP_VIEWER+ membership (or SUPER_ADMIN).
   */
  async reportingSummary(params: {
    dealerGroupId: string;
    actorUserId: string;
    isSuperAdmin: boolean;
  }) {
    if (!params.isSuperAdmin) {
      await this.assertMembership(params.actorUserId, params.dealerGroupId);
    }

    const group = await this.prisma.dealerGroup.findUnique({
      where: { id: params.dealerGroupId },
      select: { id: true, slug: true, name: true },
    });
    if (!group) throw new NotFoundException('DEALER_GROUP_NOT_FOUND');

    const tenants = await this.prisma.tenant.findMany({
      where: { dealerGroupId: params.dealerGroupId },
      select: {
        id: true,
        slug: true,
        name: true,
        _count: {
          select: {
            vehicles: true,
            leads: true,
            conversations: true,
            escalations: true,
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    return {
      dealerGroup: group,
      tenants: tenants.map((t) => ({
        id: t.id,
        slug: t.slug,
        name: t.name,
        counts: t._count,
      })),
      note: 'Group reporting is aggregate counts only. Cross-tenant record access is denied.',
    };
  }

  /**
   * All-store comparison over a window. Every number is a direct count of persisted records —
   * no modeled, projected or estimated figures. Rates are computed only from those counts and
   * reported as null when the denominator is zero.
   */
  async comparison(params: {
    dealerGroupId: string;
    actorUserId: string;
    isSuperAdmin: boolean;
    days: number;
  }) {
    if (!params.isSuperAdmin) {
      await this.assertMembership(params.actorUserId, params.dealerGroupId);
    }
    const days = Math.min(Math.max(Math.round(params.days) || 7, 1), 90);
    const since = new Date(Date.now() - days * 86_400_000);
    const tenants = await this.prisma.tenant.findMany({
      where: { dealerGroupId: params.dealerGroupId },
      select: { id: true, slug: true, name: true },
      orderBy: { name: 'asc' },
    });
    const rate = (n: number, d: number) =>
      d > 0 ? Number((n / d).toFixed(4)) : null;
    const stores: Array<Record<string, unknown>> = [];
    for (const t of tenants) {
      const w = { tenantId: t.id, createdAt: { gte: since } };
      const [
        conversations,
        leads,
        hotLeads,
        apptRequested,
        apptConfirmed,
        handoffs,
        handoffsNotified,
        quotes,
        trades,
        tradeOffers,
        finance,
        creditOffered,
        creditClicked,
        parts,
        liveVehicles,
        staleVehicles,
        syntheticVehicles,
      ] = await Promise.all([
        this.prisma.conversation.count({ where: w }),
        this.prisma.lead.count({ where: w }),
        this.prisma.lead.count({ where: { ...w, stage: 'HOT' } }),
        this.prisma.appointment.count({ where: w }),
        this.prisma.appointment.count({ where: { ...w, status: 'CONFIRMED' } }),
        this.prisma.escalation.count({ where: w }),
        this.prisma.escalation.count({
          where: { ...w, notifiedAt: { not: null } },
        }),
        this.prisma.priceQuoteRequest.count({ where: w }),
        this.prisma.tradeRequest.count({ where: w }),
        this.prisma.tradeAppraisal.count({
          where: { ...w, kind: 'FINAL_OFFER' },
        }),
        this.prisma.financeRequest.count({ where: w }),
        this.prisma.financeRequest.count({
          where: { ...w, creditLinkState: { not: 'NONE' } },
        }),
        this.prisma.financeRequest.count({
          where: {
            ...w,
            creditLinkState: { in: ['CLICKED', 'COMPLETED_VERIFIED'] },
          },
        }),
        this.prisma.partsInquiry.count({ where: w }),
        this.prisma.vehicle.count({
          where: {
            tenantId: t.id,
            status: { in: ['AVAILABLE', 'IN_TRANSIT'] },
            NOT: { source: 'synthetic_demo' },
          },
        }),
        this.prisma.vehicle.count({
          where: {
            tenantId: t.id,
            status: { in: ['AVAILABLE', 'IN_TRANSIT'] },
            freshnessState: { in: ['STALE', 'UNAVAILABLE'] },
            NOT: { source: 'synthetic_demo' },
          },
        }),
        this.prisma.vehicle.count({
          where: { tenantId: t.id, source: 'synthetic_demo' },
        }),
      ]);
      stores.push({
        tenant: t,
        counts: {
          conversations,
          leads,
          hotLeads,
          appointmentRequests: apptRequested,
          appointmentsConfirmed: apptConfirmed,
          handoffs,
          handoffsNotified,
          otdQuoteRequests: quotes,
          tradeRequests: trades,
          tradeOffersIssued: tradeOffers,
          financeRequests: finance,
          creditLinksOffered: creditOffered,
          creditLinksClicked: creditClicked,
          partsInquiries: parts,
        },
        rates: {
          leadPerConversation: rate(leads, conversations),
          appointmentConfirmation: rate(apptConfirmed, apptRequested),
          handoffDelivery: rate(handoffsNotified, handoffs),
          creditClickThrough: rate(creditClicked, creditOffered),
        },
        inventory: {
          liveVehicles,
          staleVehicles,
          syntheticFixturesPresent: syntheticVehicles > 0,
        },
      });
    }
    return {
      dealerGroupId: params.dealerGroupId,
      windowDays: days,
      since: since.toISOString(),
      stores,
      notes: [
        'Counts of persisted records only. "Appointments confirmed" counts staff/provider confirmations, never requests.',
        'AI operating cost, sales attribution and staff response-time SLAs are not reported: no verified source is connected yet.',
      ],
    };
  }

  async addMembership(params: {
    dealerGroupId: string;
    userId: string;
    role: DealerGroupRole;
    actorUserId: string;
    isSuperAdmin: boolean;
  }) {
    if (!params.isSuperAdmin) {
      await this.assertMembership(
        params.actorUserId,
        params.dealerGroupId,
        DealerGroupRole.GROUP_ADMIN,
      );
    }
    return this.prisma.dealerGroupMembership.upsert({
      where: {
        dealerGroupId_userId: {
          dealerGroupId: params.dealerGroupId,
          userId: params.userId,
        },
      },
      create: {
        dealerGroupId: params.dealerGroupId,
        userId: params.userId,
        role: params.role,
      },
      update: { role: params.role },
    });
  }
}
