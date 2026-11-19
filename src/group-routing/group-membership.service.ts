import { Injectable } from '@nestjs/common';
import { CapabilityService } from '../capability/capability.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { PrismaService } from '../prisma/prisma.service';
import type { GroupGrant } from './group-routing.types';
import {
  GROUP_SITE_FLAG,
  MEMBER_LISTED_FLAG,
  MemberTenantInput,
  resolveGroupGrant,
} from './membership';

/**
 * Loads the rows `resolveGroupGrant` decides on. Everything comes from the database for the
 * AUTHENTICATED conversation tenant; nothing from the request body. Not cached: turning a
 * flag off takes effect on the next turn.
 */
@Injectable()
export class GroupMembershipService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: FeatureFlagsService,
    private readonly capabilities: CapabilityService,
  ) {}

  async resolve(
    conversationTenantId: string,
    conversationLocationId?: string | null,
  ): Promise<GroupGrant | null> {
    // One indexed lookup for every non-group tenant; they stop here.
    const group = await this.prisma.dealerGroup.findUnique({
      where: { groupSiteTenantId: conversationTenantId },
      select: { id: true, slug: true, name: true, groupSiteTenantId: true },
    });
    if (!group) return null;
    const groupSiteFlags = await this.flags.resolve(
      conversationTenantId,
      conversationLocationId,
    );
    if (groupSiteFlags[GROUP_SITE_FLAG] !== true) return null;
    const groupSiteTenant = await this.prisma.tenant.findUnique({
      where: { id: conversationTenantId },
      select: { id: true, dealerGroupId: true },
    });
    const rows = await this.prisma.tenant.findMany({
      where: { dealerGroupId: group.id, id: { not: conversationTenantId } },
      select: {
        id: true,
        slug: true,
        name: true,
        dealerGroupId: true,
        publicConfig: true,
        locations: {
          select: { id: true, name: true },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { name: 'asc' },
    });
    const tenants: MemberTenantInput[] = [];
    for (const t of rows) {
      const locations: MemberTenantInput['locations'] = [];
      for (const l of t.locations) {
        const listed =
          (await this.flags.resolve(t.id, l.id))[MEMBER_LISTED_FLAG] === true;
        // The same gate the rooftop's own search passes before it reads inventory.
        const inventoryReady = listed
          ? (await this.capabilities.check(t.id, l.id, 'inventory')).allowed
          : false;
        locations.push({ id: l.id, name: l.name, listed, inventoryReady });
      }
      tenants.push({ ...t, locations });
    }
    return resolveGroupGrant({
      conversationTenantId,
      group,
      groupSiteTenant,
      groupSiteFlags,
      tenants,
    }).grant;
  }
}
