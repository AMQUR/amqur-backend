import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryVehicle } from '../chat/types/vehicle.types';
import { VehicleStatus, Prisma, InventoryFreshnessState } from '@prisma/client';

export type UpsertVehiclesMeta = {
  source?: string;
  importRunId?: string;
  freshnessState?: InventoryFreshnessState;
  feedSourceKey?: string;
  /** When false, strip advertised price even if present in the feed. */
  publishPrices?: boolean;
  /** When false, strip photo URLs (rights not verified). */
  publishPhotos?: boolean;
};

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  async upsertVehicle(params: {
    tenantId: string;
    locationId?: string | null;
    vehicle: Partial<InventoryVehicle> & { vin: string };
  }) {
    const v = params.vehicle;
    if (!v?.vin) return;

    const vin = v.vin.toUpperCase().trim();

    return this.prisma.vehicle.upsert({
      where: {
        tenantId_vin: { tenantId: params.tenantId, vin },
      },
      update: {
        stock: v.stock ?? undefined,
        year: v.year,
        make: v.make,
        model: v.model,
        trim: v.trim ?? null,
        bodyType: v.bodyType ?? null,
        drivetrain: v.drivetrain ?? null,
        transmission: v.transmission ?? null,
        fuelType: v.fuelType ?? null,
        color: v.color ?? null,
        price: v.price ?? null,
        msrp: v.msrp ?? null,
        mileage: v.mileage ?? null,
        photos: (v.photos as Prisma.InputJsonValue) ?? undefined,
        locationId: params.locationId ?? null,
        status: VehicleStatus.AVAILABLE,
        lastSeenAt: new Date(),
      },
      create: {
        vin,
        stock: v.stock ?? null,
        year: v.year ?? 0,
        make: v.make ?? 'UNKNOWN',
        model: v.model ?? 'UNKNOWN',
        trim: v.trim ?? null,
        bodyType: v.bodyType ?? null,
        drivetrain: v.drivetrain ?? null,
        transmission: v.transmission ?? null,
        fuelType: v.fuelType ?? null,
        color: v.color ?? null,
        price: v.price ?? null,
        msrp: v.msrp ?? null,
        mileage: v.mileage ?? null,
        photos: (v.photos as Prisma.InputJsonValue) ?? undefined,
        tenantId: params.tenantId,
        locationId: params.locationId ?? null,
        status: VehicleStatus.AVAILABLE,
        lastSeenAt: new Date(),
      },
    });
  }

  async upsertVehicles(
    tenantId: string,
    locationId: string | null,
    vehicles: InventoryVehicle[],
    meta?: UpsertVehiclesMeta,
  ) {
    const now = new Date();
    const source = meta?.source ?? null;
    const importRunId = meta?.importRunId ?? null;
    const freshnessState =
      meta?.freshnessState ?? InventoryFreshnessState.FRESH;
    const feedSourceKey = meta?.feedSourceKey ?? null;
    const publishPrices = meta?.publishPrices === true;
    const publishPhotos = meta?.publishPhotos === true;

    for (const v of vehicles) {
      if (!v?.vin) continue;
      const vin = v.vin.toUpperCase().trim();
      const price = publishPrices ? (v.price ?? null) : null;
      const photos = publishPhotos
        ? ((v.photos as Prisma.InputJsonValue) ?? undefined)
        : [];

      await this.prisma.vehicle.upsert({
        where: {
          tenantId_vin: { tenantId, vin },
        },
        update: {
          stock: v.stock ?? null,
          year: v.year ?? 0,
          make: v.make ?? 'UNKNOWN',
          model: v.model ?? 'UNKNOWN',
          trim: v.trim ?? null,
          bodyType: v.bodyType ?? null,
          drivetrain: v.drivetrain ?? null,
          transmission: v.transmission ?? null,
          fuelType: v.fuelType ?? null,
          color: v.color ?? null,
          price,
          msrp: v.msrp ?? null,
          mileage: v.mileage ?? null,
          photos,
          condition: v.condition ?? undefined,
          locationId,
          status: VehicleStatus.AVAILABLE,
          lastSeenAt: now,
          listingRemovedAt: null,
          explicitSoldEvidence: null,
          source: source ?? v.source ?? undefined,
          importRunId: importRunId ?? undefined,
          freshnessState,
          feedSourceKey: feedSourceKey ?? undefined,
        },
        create: {
          vin,
          stock: v.stock ?? null,
          year: v.year ?? 0,
          make: v.make ?? 'UNKNOWN',
          model: v.model ?? 'UNKNOWN',
          trim: v.trim ?? null,
          bodyType: v.bodyType ?? null,
          drivetrain: v.drivetrain ?? null,
          transmission: v.transmission ?? null,
          fuelType: v.fuelType ?? null,
          color: v.color ?? null,
          price,
          msrp: v.msrp ?? null,
          mileage: v.mileage ?? null,
          photos: photos ?? [],
          condition: v.condition ?? null,
          tenantId,
          locationId,
          status: VehicleStatus.AVAILABLE,
          lastSeenAt: now,
          source: source ?? v.source ?? null,
          importRunId,
          freshnessState,
          feedSourceKey,
        },
      });
    }
  }

  /**
   * After a *successful* snapshot for one feed source:
   * - Vehicles in that source not refreshed in this run → MISSING (not SOLD).
   * - Long-missing vehicles → REMOVED_FROM_LISTING (still not SOLD).
   * - SOLD is never inferred from absence; use {@link markExplicitlySold}.
   *
   * Scoping by feedSourceKey ensures a New feed cannot wipe Used stock (and vice versa).
   */
  async updateVehicleLifecycle(
    locationId: string,
    opts: {
      feedSourceKey?: string | null;
      /** Start of the successful import; rows with lastSeenAt >= this stay AVAILABLE. */
      snapshotStartedAt: Date;
      /** Days in MISSING before REMOVED_FROM_LISTING (default 14). */
      removedAfterDays?: number;
    },
  ) {
    const removedAfterDays = opts.removedAfterDays ?? 14;
    const removedThreshold = new Date(
      opts.snapshotStartedAt.getTime() - removedAfterDays * 24 * 60 * 60 * 1000,
    );
    const sourceFilter = opts.feedSourceKey
      ? { feedSourceKey: opts.feedSourceKey }
      : {};

    await this.prisma.vehicle.updateMany({
      where: {
        locationId,
        ...sourceFilter,
        status: {
          in: [
            VehicleStatus.AVAILABLE,
            VehicleStatus.IN_TRANSIT,
            VehicleStatus.HOLD,
            VehicleStatus.PENDING_RECONCILIATION,
          ],
        },
        OR: [
          { lastSeenAt: null },
          { lastSeenAt: { lt: opts.snapshotStartedAt } },
        ],
      },
      data: {
        status: VehicleStatus.MISSING,
        freshnessState: InventoryFreshnessState.DEGRADED,
      },
    });

    await this.prisma.vehicle.updateMany({
      where: {
        locationId,
        ...sourceFilter,
        status: VehicleStatus.MISSING,
        OR: [
          { lastSeenAt: null },
          { lastSeenAt: { lt: removedThreshold } },
        ],
      },
      data: {
        status: VehicleStatus.REMOVED_FROM_LISTING,
        listingRemovedAt: new Date(),
        freshnessState: InventoryFreshnessState.STALE,
      },
    });
  }

  /**
   * Mark SOLD only with vendor/staff evidence. Absence from a feed is never enough.
   */
  async markExplicitlySold(params: {
    tenantId: string;
    vin: string;
    evidence: string;
  }) {
    const vin = params.vin.toUpperCase().trim();
    const evidence = params.evidence.trim().slice(0, 200);
    if (!evidence) throw new Error('sold_evidence_required');
    return this.prisma.vehicle.updateMany({
      where: { tenantId: params.tenantId, vin },
      data: {
        status: VehicleStatus.SOLD,
        explicitSoldEvidence: evidence,
        freshnessState: InventoryFreshnessState.UNAVAILABLE,
      },
    });
  }

  async quarantineVehicle(params: {
    tenantId: string;
    vin: string;
    reason: string;
  }) {
    const vin = params.vin.toUpperCase().trim();
    return this.prisma.vehicle.updateMany({
      where: { tenantId: params.tenantId, vin },
      data: {
        status: VehicleStatus.QUARANTINED,
        freshnessState: InventoryFreshnessState.UNAVAILABLE,
        rawSource: { quarantineReason: params.reason.slice(0, 200) },
      },
    });
  }
}
