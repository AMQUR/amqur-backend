import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryVehicle } from '../chat/types/vehicle.types';
import { VehicleStatus, Prisma } from '@prisma/client';

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
  ) {
    const now = new Date();

    for (const v of vehicles) {
      if (!v?.vin) continue;
      const vin = v.vin.toUpperCase().trim();

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
          price: v.price ?? null,
          msrp: v.msrp ?? null,
          mileage: v.mileage ?? null,
          photos: (v.photos as Prisma.InputJsonValue) ?? undefined,
          locationId,
          status: VehicleStatus.AVAILABLE,
          lastSeenAt: now,
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
          tenantId,
          locationId,
          status: VehicleStatus.AVAILABLE,
          lastSeenAt: now,
        },
      });
    }
  }

  async updateVehicleLifecycle(locationId: string) {
    const now = new Date();
    const missingThreshold = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const soldThreshold = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    await this.prisma.vehicle.updateMany({
      where: {
        locationId,
        status: VehicleStatus.AVAILABLE,
        lastSeenAt: { lt: missingThreshold },
      },
      data: { status: VehicleStatus.MISSING },
    });

    await this.prisma.vehicle.updateMany({
      where: {
        locationId,
        status: VehicleStatus.MISSING,
        lastSeenAt: { lt: soldThreshold },
      },
      data: { status: VehicleStatus.SOLD },
    });
  }
}
