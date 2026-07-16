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
