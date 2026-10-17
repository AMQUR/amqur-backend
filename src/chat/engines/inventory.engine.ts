import { Injectable } from '@nestjs/common';
import { Prisma, Vehicle } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { InventoryVehicle } from '../types/vehicle.types';
import { FEATURE_SYNONYMS } from '../understanding/turn-understanding';

export type InventoryCriteria = {
  tenantId: string;
  locationId?: string | null;
  /** When the dealer group permits cross-rooftop search, pass all permitted location ids. */
  locationIds?: string[] | null;
  query?: string;
  make?: string;
  model?: string;
  year?: number;
  yearMin?: number;
  maxPrice?: number;
  maxMileage?: number;
  color?: string;
  bodyType?: string;
  drivetrain?: string;
  condition?: 'new' | 'used' | 'certified';
  fuel?: 'electric' | 'hybrid' | 'gas' | 'diesel';
  features?: string[];
  includeInTransit?: boolean;
  sortBy?: 'price_asc' | 'price_desc' | 'miles_asc' | 'newest';
  limit?: number;
};

export function vehicleHasFeature(
  features: unknown,
  canonical: string,
): boolean | null {
  if (!Array.isArray(features) || features.length === 0) return null; // unknown, not "no"
  const hay = features.map((f) => String(f).toLowerCase()).join(' | ');
  const syns = [canonical, ...(FEATURE_SYNONYMS[canonical] ?? [])];
  return syns.some((s) => hay.includes(s.trim().toLowerCase()));
}

/**
 * inventory.search / inventory.getVehicle tool. Facts come only from the Vehicle table that
 * feed ingestion maintains. No payment math here (FinancialAssumptionPolicy owns that), no
 * stock/demo imagery, and no mutation of authoritative inventory.
 */
export const SYNTHETIC_SOURCE = 'synthetic_demo';

@Injectable()
export class InventoryEngine {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Synthetic demo vehicles (source=synthetic_demo) exist only in disposable local/demo
   * databases. In production they are invisible to every customer-facing read, so a fixture
   * can never be presented as dealership inventory.
   */
  static liveOnly(): Prisma.VehicleWhereInput {
    return process.env.NODE_ENV === 'production'
      ? { NOT: { source: SYNTHETIC_SOURCE } }
      : {};
  }

  /** What kind of inventory backs this rooftop — drives honest "no match" wording. */
  async sourceKind(
    tenantId: string,
    locationId: string | null | undefined,
  ): Promise<'synthetic' | 'live' | 'mixed' | 'empty'> {
    const where: Prisma.VehicleWhereInput = {
      tenantId,
      ...(locationId ? { OR: [{ locationId }, { locationId: null }] } : {}),
      ...InventoryEngine.liveOnly(),
    };
    const [synthetic, total] = await Promise.all([
      this.prisma.vehicle.count({
        where: { ...where, source: SYNTHETIC_SOURCE },
      }),
      this.prisma.vehicle.count({ where }),
    ]);
    if (!total) return 'empty';
    if (synthetic === total) return 'synthetic';
    return synthetic ? 'mixed' : 'live';
  }

  static toCard(
    v: Vehicle,
  ): InventoryVehicle & { features?: string[]; condition?: string | null } {
    return {
      id: v.id,
      vin: v.vin,
      stock: v.stock,
      year: v.year,
      make: v.make,
      model: v.model,
      trim: v.trim ?? undefined,
      price: v.price ?? undefined,
      msrp: v.msrp ?? undefined,
      mileage: v.mileage ?? undefined,
      color: v.color ?? undefined,
      drivetrain: v.drivetrain ?? undefined,
      bodyType: v.bodyType ?? undefined,
      transmission: v.transmission ?? undefined,
      fuelType: v.fuelType ?? undefined,
      photos: Array.isArray(v.photos)
        ? (v.photos as unknown[])
            .filter(
              (p): p is string =>
                typeof p === 'string' && /^https:\/\//.test(p),
            )
            .slice(0, 12)
        : [],
      features: Array.isArray(v.features)
        ? (v.features as unknown[]).map(String).slice(0, 60)
        : undefined,
      condition: v.condition,
      status: v.status,
      locationId: v.locationId,
      lastSeenAt: v.lastSeenAt ? v.lastSeenAt.toISOString() : null,
      source: v.source ?? null,
      simulated: v.source === SYNTHETIC_SOURCE,
      freshnessState: v.freshnessState ?? null,
    };
  }

  async searchVehicles(c: InventoryCriteria) {
    const AND: Prisma.VehicleWhereInput[] = [
      { tenantId: c.tenantId },
      InventoryEngine.liveOnly(),
      {
        status: {
          in:
            c.includeInTransit === false
              ? ['AVAILABLE']
              : ['AVAILABLE', 'IN_TRANSIT'],
        },
      },
    ];
    if (c.locationIds?.length) AND.push({ locationId: { in: c.locationIds } });
    else if (c.locationId)
      AND.push({ OR: [{ locationId: c.locationId }, { locationId: null }] });
    if (c.make) AND.push({ make: { equals: c.make, mode: 'insensitive' } });
    if (c.model)
      AND.push({
        model: { contains: c.model.replace(/s$/i, ''), mode: 'insensitive' },
      });
    if (c.year) AND.push({ year: c.year });
    if (c.yearMin) AND.push({ year: { gte: c.yearMin } });
    if (c.maxPrice) AND.push({ price: { lte: c.maxPrice } });
    if (c.maxMileage) AND.push({ mileage: { lte: c.maxMileage } });
    if (c.color)
      AND.push({ color: { contains: c.color, mode: 'insensitive' } });
    if (c.bodyType)
      AND.push({
        bodyType: {
          contains: c.bodyType === 'Truck' ? 'truck' : c.bodyType,
          mode: 'insensitive',
        },
      });
    if (c.drivetrain) {
      const dt =
        c.drivetrain === '4WD' ? ['4WD', '4x4', 'Four'] : [c.drivetrain];
      AND.push({
        OR: dt.map((d) => ({
          drivetrain: { contains: d, mode: 'insensitive' as const },
        })),
      });
    }
    if (c.condition) {
      AND.push(
        c.condition === 'used'
          ? {
              OR: [
                {
                  condition: { in: ['used', 'certified', 'Used', 'Certified'] },
                },
              ],
            }
          : { condition: { equals: c.condition, mode: 'insensitive' } },
      );
    }
    if (c.fuel === 'electric')
      AND.push({ fuelType: { contains: 'electric', mode: 'insensitive' } });
    if (c.fuel === 'hybrid')
      AND.push({
        OR: [
          { fuelType: { contains: 'hybrid', mode: 'insensitive' } },
          { trim: { contains: '4xe', mode: 'insensitive' } },
        ],
      });
    if (c.fuel === 'diesel')
      AND.push({ fuelType: { contains: 'diesel', mode: 'insensitive' } });
    const q = c.query?.trim();
    if (q && !c.model && !c.make) {
      const terms = q
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2)
        .slice(0, 4);
      for (const term of terms) {
        AND.push({
          OR: [
            { make: { contains: term, mode: 'insensitive' } },
            { model: { contains: term, mode: 'insensitive' } },
            { trim: { contains: term, mode: 'insensitive' } },
          ],
        });
      }
    }
    const orderBy: Prisma.VehicleOrderByWithRelationInput[] =
      c.sortBy === 'price_asc'
        ? [{ price: 'asc' }]
        : c.sortBy === 'price_desc'
          ? [{ price: 'desc' }]
          : c.sortBy === 'miles_asc'
            ? [{ mileage: 'asc' }]
            : [{ lastSeenAt: 'desc' }, { createdAt: 'desc' }];
    const rows = await this.prisma.vehicle.findMany({
      where: { AND },
      orderBy,
      take: Math.min(c.limit ?? 24, 60),
    });
    let cards = rows.map(InventoryEngine.toCard);
    if (c.features?.length) {
      // Only VERIFIED feature data can satisfy a feature constraint; unknown ≠ match.
      cards = cards.filter((v) =>
        c.features!.every((f) => vehicleHasFeature(v.features, f) === true),
      );
    }
    return cards;
  }

  async getVehiclesByVin(tenantId: string, vins: string[]) {
    const rows = await this.prisma.vehicle.findMany({
      where: {
        tenantId,
        vin: { in: vins.map((v) => v.toUpperCase()) },
        ...InventoryEngine.liveOnly(),
      },
    });
    const byVin = new Map(rows.map((r) => [r.vin, InventoryEngine.toCard(r)]));
    return vins
      .map((v) => byVin.get(v.toUpperCase()))
      .filter((v): v is NonNullable<typeof v> => !!v);
  }

  /** Returns the row regardless of status — callers MUST check `status` before claiming availability. */
  async getVehicleByVin(tenantId: string, vin: string) {
    const row = await this.prisma.vehicle.findFirst({
      where: {
        tenantId,
        vin: vin.toUpperCase(),
        ...InventoryEngine.liveOnly(),
      },
    });
    return row ? InventoryEngine.toCard(row) : null;
  }

  async getVehicleByStock(tenantId: string, stock: string) {
    const row = await this.prisma.vehicle.findFirst({
      where: {
        tenantId,
        stock: { equals: stock, mode: 'insensitive' },
        ...InventoryEngine.liveOnly(),
      },
    });
    return row ? InventoryEngine.toCard(row) : null;
  }

  /** Similar sellable vehicles when the requested one is sold/missing. */
  async alternatives(
    tenantId: string,
    locationId: string | null | undefined,
    v: { make?: string; model?: string; bodyType?: string; price?: number },
  ) {
    const first = await this.searchVehicles({
      tenantId,
      locationId,
      make: v.make,
      model: v.model,
      limit: 6,
    });
    if (first.length) return first;
    return this.searchVehicles({
      tenantId,
      locationId,
      bodyType: v.bodyType,
      maxPrice: v.price ? Math.round(v.price * 1.15) : undefined,
      limit: 6,
    });
  }

  /**
   * Command Center browse — same Vehicle table as chat, all lifecycle statuses, no
   * customer-facing availability claims (callers display `status` verbatim).
   */
  async browseForStaff(c: {
    tenantId: string;
    locationId?: string | null;
    vin?: string;
    stock?: string;
    make?: string;
    model?: string;
    q?: string;
    limit?: number;
  }) {
    const vin = c.vin?.trim();
    if (vin) {
      const row = await this.getVehicleByVin(c.tenantId, vin);
      return row ? [row] : [];
    }
    const stock = c.stock?.trim();
    if (stock) {
      const row = await this.getVehicleByStock(c.tenantId, stock);
      return row ? [row] : [];
    }

    const AND: Prisma.VehicleWhereInput[] = [
      { tenantId: c.tenantId },
      InventoryEngine.liveOnly(),
    ];
    if (c.locationId)
      AND.push({ OR: [{ locationId: c.locationId }, { locationId: null }] });
    const make = c.make?.trim();
    if (make) AND.push({ make: { contains: make, mode: 'insensitive' } });
    const model = c.model?.trim();
    if (model)
      AND.push({
        model: { contains: model.replace(/s$/i, ''), mode: 'insensitive' },
      });
    const q = c.q?.trim();
    if (q) {
      const upper = q.toUpperCase();
      AND.push({
        OR: [
          { make: { contains: q, mode: 'insensitive' } },
          { model: { contains: q, mode: 'insensitive' } },
          { trim: { contains: q, mode: 'insensitive' } },
          { vin: { contains: upper } },
          { stock: { contains: q, mode: 'insensitive' } },
        ],
      });
    }

    const rows = await this.prisma.vehicle.findMany({
      where: { AND },
      orderBy: [{ lastSeenAt: 'desc' }, { createdAt: 'desc' }],
      take: Math.min(c.limit ?? 50, 100),
    });
    return rows.map(InventoryEngine.toCard);
  }
}
