import { Injectable, Logger } from '@nestjs/common';
import {
  InventoryCriteria,
  InventoryEngine,
} from '../chat/engines/inventory.engine';
import { MetricsService } from '../observability/metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  GroupScope,
  groupVehicleScope,
  runInGroupScope,
} from './group-read-scope';
import type { GroupGrant, GroupMember } from './group-routing.types';

export type OwnedVehicleRow = {
  vin: string;
  tenantId: string;
  locationId: string | null;
  year: number;
  make: string;
  model: string;
  trim: string | null;
  color: string | null;
  price: number | null;
};

/**
 * The one audited door for a group-site conversation to read rooftop inventory. Every method
 * takes a `GroupGrant` (or members taken from one), which only GroupMembershipService can
 * produce from database rows. Reads are counted (`group_routing.cross_rooftop_read`) and
 * traced without any customer data. Nothing here reads leads, contacts or appointments.
 */
@Injectable()
export class GroupInventoryService {
  private readonly logger = new Logger(GroupInventoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryEngine,
    private readonly metrics: MetricsService,
  ) {}

  private trace(grant: GroupGrant, what: string, rooftops: number) {
    this.metrics.increment('group_routing.cross_rooftop_read');
    this.logger.debug(
      `cross-rooftop read: ${what} group=${grant.groupSlug} rooftops=${rooftops}`,
    );
  }

  /** Run the group site's own conversation turn with its inventory reads widened. */
  async runScoped<T>(scope: GroupScope, fn: () => Promise<T>): Promise<T> {
    const out = await runInGroupScope(scope, fn);
    if (scope.outcome.reads)
      this.trace(scope.grant, 'search', scope.searchable.length);
    return out;
  }

  /**
   * How many vehicles each rooftop holds for these criteria — asked of each rooftop with its
   * OWN tenant-filtered search, so every rooftop's own rules apply unchanged.
   */
  async matchesByRooftop(
    grant: GroupGrant,
    members: readonly GroupMember[],
    criteria: Omit<
      InventoryCriteria,
      'tenantId' | 'locationId' | 'locationIds'
    >,
  ): Promise<{ counts: Record<string, number>; sampleModel: string | null }> {
    this.trace(grant, 'match-count', members.length);
    const counts: Record<string, number> = {};
    let sampleModel: string | null = null;
    for (const m of members) {
      const rows = await this.inventory.searchVehicles({
        ...criteria,
        tenantId: m.tenantId,
        locationIds: null,
        locationId: m.primaryLocationId,
        limit: 6,
      });
      const mine = rows.filter(
        (v) => !v.locationId || m.locationIds.includes(v.locationId),
      );
      counts[m.tenantId] = mine.length;
      sampleModel = sampleModel ?? mine[0]?.model ?? null;
    }
    return { counts, sampleModel };
  }

  /** Which listed rooftop(s) hold these VINs / this stock number (customer-visible rows only). */
  async owners(
    grant: GroupGrant,
    by: { vins?: string[]; stock?: string },
  ): Promise<OwnedVehicleRow[]> {
    const vins = (by.vins ?? []).map((v) => v.toUpperCase()).slice(0, 60);
    if (!vins.length && !by.stock) return [];
    this.trace(grant, 'owner-lookup', grant.members.length);
    return this.prisma.vehicle.findMany({
      where: {
        AND: [
          groupVehicleScope(grant.members),
          InventoryEngine.liveOnly(),
          vins.length
            ? { vin: { in: vins } }
            : { stock: { equals: by.stock, mode: 'insensitive' } },
        ],
      },
      select: {
        vin: true,
        tenantId: true,
        locationId: true,
        year: true,
        make: true,
        model: true,
        trim: true,
        color: true,
        price: true,
      },
      take: 120,
    });
  }
}
