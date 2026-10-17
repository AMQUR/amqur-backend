import { InventoryFreshnessState, VehicleStatus } from '@prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';

export const JOURNEY_SLUG = 'journey-motors';
export const JOURNEY_ORIGIN = 'http://127.0.0.1:18084';

/** Sanitized fixture dealership (idempotent). Never customer data. */
export async function seedJourneyMotors(prisma: PrismaService) {
  const tenant = await prisma.tenant.upsert({
    where: { slug: JOURNEY_SLUG },
    create: {
      slug: JOURNEY_SLUG,
      name: 'Journey Motors (fixture)',
      allowedOrigins: JOURNEY_ORIGIN,
    },
    update: { allowedOrigins: JOURNEY_ORIGIN },
  });
  await prisma.tenant.update({
    where: { id: tenant.id },
    data: {
      featureFlags: {
        chat: true,
        inventory: true,
        payments: true,
        financeCalculator: true,
        appointments: true,
        serviceAi: true,
        partsAi: true,
        leadCapture: true,
        handoff: true,
        vehicleCompare: true,
        knowledge: false,
      },
      creditApplication: {
        enabled: true,
        url: 'https://apply.journey-motors.test/credit',
        label: 'Secure credit application',
        allowedHosts: ['apply.journey-motors.test'],
        lastVerifiedAt: '2026-10-01T00:00:00Z',
        verifiedBy: 'fixture',
      },
    },
  });
  const loc = await prisma.location.upsert({
    where: { tenantId_slug: { tenantId: tenant.id, slug: 'main' } },
    create: {
      tenantId: tenant.id,
      slug: 'main',
      name: 'Journey Motors Main',
      phone: '555-0199',
      timezone: 'America/Chicago',
    },
    update: {},
  });
  const week = { open: '09:00', close: '19:00' };
  const svc = { open: '07:00', close: '18:00' };
  await prisma.location.update({
    where: { id: loc.id },
    data: {
      storeHours: {
        mon: week,
        tue: week,
        wed: week,
        thu: week,
        fri: week,
        sat: { open: '09:00', close: '18:00' },
        sun: null,
      },
      departmentHours: {
        service: {
          mon: svc,
          tue: svc,
          wed: svc,
          thu: svc,
          fri: svc,
          sat: { open: '07:30', close: '14:00' },
          sun: null,
        },
      },
      storeHoursVerifiedAt: new Date('2026-10-01T00:00:00Z'),
    },
  });
  const now = new Date();
  const vehicles: Array<{
    vin: string;
    stock: string;
    make: string;
    model: string;
    trim: string;
    color: string;
    price: number;
    features: string[];
    status?: VehicleStatus;
    fresh?: InventoryFreshnessState;
    seen?: Date;
    condition?: string;
    mileage?: number;
  }> = [
    {
      vin: '1C4HJXDG0RW100001',
      stock: 'JM1',
      make: 'Jeep',
      model: 'Wrangler',
      trim: 'Sport S',
      color: 'Black',
      price: 41995,
      features: ['Heated front seats', 'Apple CarPlay'],
    },
    {
      vin: '1C4HJXFG0RW100002',
      stock: 'JM2',
      make: 'Jeep',
      model: 'Wrangler',
      trim: 'Rubicon',
      color: 'Black',
      price: 44500,
      features: ['Apple CarPlay', 'Tow package'],
    },
    {
      vin: '1C4HJXEG0RW100003',
      stock: 'JM3',
      make: 'Jeep',
      model: 'Wrangler',
      trim: 'Sahara',
      color: 'Red',
      price: 43995,
      features: ['Heated front seats'],
    },
    {
      vin: '1C4RJHBG0RC100004',
      stock: 'JM4',
      make: 'Jeep',
      model: 'Grand Cherokee',
      trim: 'Limited',
      color: 'White',
      price: 49990,
      features: [],
    },
    {
      vin: '1FMDE5BH0RLA00005',
      stock: 'JM5',
      make: 'Ford',
      model: 'Bronco',
      trim: 'Big Bend',
      color: 'Gray',
      price: 46990,
      features: [],
      fresh: InventoryFreshnessState.STALE,
      seen: new Date(now.getTime() - 10 * 86_400_000),
      condition: 'used',
      mileage: 12000,
    },
    {
      vin: '3TMLB5JN0RM100006',
      stock: 'JM6',
      make: 'Toyota',
      model: 'Tacoma',
      trim: 'TRD Off-Road',
      color: 'Blue',
      price: 44990,
      features: [],
      status: VehicleStatus.SOLD,
      condition: 'used',
      mileage: 9000,
    },
    {
      vin: '1C6SRFFT0RN100007',
      stock: 'JM7',
      make: 'Ram',
      model: '1500',
      trim: 'Laramie',
      color: 'Silver',
      price: 58990,
      features: [],
      status: VehicleStatus.IN_TRANSIT,
    },
  ];
  for (const v of vehicles) {
    const data = {
      locationId: loc.id,
      stock: v.stock,
      year: 2024,
      make: v.make,
      model: v.model,
      trim: v.trim,
      color: v.color,
      price: v.price,
      mileage: v.mileage ?? 10,
      features: v.features,
      condition: v.condition ?? 'new',
      bodyType: v.make === 'Ram' || v.model === 'Tacoma' ? 'Truck' : 'SUV',
      status: v.status ?? VehicleStatus.AVAILABLE,
      source: 'test_fixture',
      lastSeenAt: v.seen ?? now,
      freshnessState: v.fresh ?? InventoryFreshnessState.FRESH,
    };
    await prisma.vehicle.upsert({
      where: { tenantId_vin: { tenantId: tenant.id, vin: v.vin } },
      create: { tenantId: tenant.id, vin: v.vin, ...data },
      update: data,
    });
  }
  return { tenantId: tenant.id, locationId: loc.id };
}
