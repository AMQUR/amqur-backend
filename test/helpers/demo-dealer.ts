import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { CreditDestinationAdminService } from '../../src/finance/credit-destination-admin.service';
import {
  DEMO_HOURS,
  DEMO_VEHICLES,
  DemoVehicle,
} from '../../scripts/lib/local-demo-data';

export const SIM_ORIGIN = 'http://127.0.0.1:18084';

/** A second dealership whose stock must NEVER appear for the first one (cross-tenant probes). */
export const RIVAL_VEHICLES: DemoVehicle[] = [
  {
    vin: 'RIVLNS25RGOOOOO01',
    stock: 'RIV-1',
    year: 2025,
    make: 'Nissan',
    model: 'Rogue',
    trim: 'SV AWD',
    bodyType: 'SUV',
    drivetrain: 'AWD',
    fuelType: 'Gasoline',
    color: 'Gun Metallic',
    price: 33120,
    mileage: 5,
    condition: 'new',
    features: ['apple carplay'],
  },
  {
    vin: 'RIVLWR24SPOOOOO02',
    stock: 'RIV-2',
    year: 2024,
    make: 'Jeep',
    model: 'Wrangler',
    trim: 'Sahara 4x4',
    bodyType: 'SUV',
    drivetrain: '4WD',
    fuelType: 'Gasoline',
    color: 'Sarge Green',
    price: 47777,
    mileage: 3210,
    condition: 'used',
    features: ['heated seats'],
  },
];

export type DemoDealer = {
  slug: string;
  tenantId: string;
  locationId: string;
  vehicles: DemoVehicle[];
};

/**
 * Seeds an isolated SIMULATED dealership (idempotent) with the local-demo dataset or a given
 * vehicle list. Hours are synthetic; inventory is source=synthetic_demo.
 */
export async function seedDemoDealer(
  app: INestApplication,
  prisma: PrismaService,
  slug: string,
  opts: {
    vehicles?: DemoVehicle[];
    creditPreview?: boolean;
    flags?: Record<string, boolean>;
  } = {},
): Promise<DemoDealer> {
  const vehicles = opts.vehicles ?? DEMO_VEHICLES;
  const tenant = await prisma.tenant.upsert({
    where: { slug },
    create: { slug, name: `${slug} (simulated)`, allowedOrigins: SIM_ORIGIN },
    update: { allowedOrigins: SIM_ORIGIN },
  });
  await prisma.tenant.update({
    where: { id: tenant.id },
    data: {
      featureFlags: {
        chat: true,
        inventory: true,
        payments: true,
        financeCalculator: true,
        vehicleCompare: true,
        leadCapture: true,
        serviceAi: true,
        partsAi: true,
        appointments: true,
        handoff: true,
        knowledge: false,
        ...(opts.flags ?? {}),
      },
    },
  });
  const loc = await prisma.location.upsert({
    where: { tenantId_slug: { tenantId: tenant.id, slug: 'main' } },
    create: {
      tenantId: tenant.id,
      slug: 'main',
      name: `${slug} main`,
      timezone: 'America/Chicago',
    },
    update: {},
  });
  await prisma.location.update({
    where: { id: loc.id },
    data: {
      storeHours: DEMO_HOURS.storeHours,
      departmentHours: DEMO_HOURS.departmentHours,
      storeHoursVerifiedAt: new Date(),
      storeHoursVerifiedBy: 'synthetic-demo (simulator fixture)',
    },
  });
  const now = new Date();
  for (const v of vehicles) {
    const data = {
      tenantId: tenant.id,
      locationId: loc.id,
      vin: v.vin,
      stock: v.stock,
      year: v.year,
      make: v.make,
      model: v.model,
      trim: v.trim,
      bodyType: v.bodyType,
      drivetrain: v.drivetrain,
      fuelType: v.fuelType,
      color: v.color,
      price: v.price,
      msrp: v.msrp ?? null,
      mileage: v.mileage,
      condition: v.condition,
      features: v.features,
      photos: [],
      status: v.status ?? ('AVAILABLE' as const),
      source: 'synthetic_demo',
      lastSeenAt: now,
      freshnessState: 'FRESH' as const,
    };
    await prisma.vehicle.upsert({
      where: { tenantId_vin: { tenantId: tenant.id, vin: v.vin } },
      create: data,
      update: data,
    });
  }
  if (opts.creditPreview !== false) {
    await app
      .get(CreditDestinationAdminService)
      .configure(tenant.id, loc.id, 'cli:simulator', {
        url: `https://consumer-credit.tekioncloud.com/creditApplication?token=${slug}-fixture-not-real`,
        linkType: 'UNVERIFIED',
        demoPreview: true,
      });
  }
  return { slug, tenantId: tenant.id, locationId: loc.id, vehicles };
}
