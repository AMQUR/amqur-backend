/**
 * SYNTHETIC five-rooftop + group-site dataset for local/demo/test databases only.
 * Shared by scripts/seed-group-rooftops.ts and the group-routing e2e suite.
 *
 * Nothing here is a real dealership record: VINs start with "DEMO" (a real VIN can never
 * contain the letter O), prices are made up, there are no photos, phone numbers or addresses,
 * hours are the labelled synthetic demo hours, and lead routes point at example.invalid.
 * The display names are the owner-approved public names of the five rooftops.
 */
import type { PrismaClient } from '@prisma/client';
import { DEMO_HOURS } from './local-demo-data';

export type SeedRooftopKey =
  | 'chevy'
  | 'nissan'
  | 'infiniti'
  | 'south'
  | 'north';

type V = {
  vin: string;
  year: number;
  make: string;
  model: string;
  trim: string;
  color: string;
  price: number;
  bodyType?: string;
  drivetrain?: string;
  condition?: 'new' | 'used';
  mileage?: number;
};

export const GROUP_SITE = {
  slug: 'dial-auto-group',
  name: 'Dial Auto Group',
} as const;

export const SEED_ROOFTOPS: Record<
  SeedRooftopKey,
  {
    slug: string;
    name: string;
    side?: 'north' | 'south';
    aliases: string[];
    vehicles: V[];
  }
> = {
  chevy: {
    slug: 'dial-chevy-of-chicago',
    name: 'Dial Chevy of Chicago',
    aliases: ['dial chevy', 'dial chevrolet'],
    vehicles: [
      {
        vin: 'DEMO00000000000C1',
        year: 2026,
        make: 'Chevrolet',
        model: 'Silverado 1500',
        trim: 'LT Crew Cab',
        color: 'Summit White',
        price: 52840,
        bodyType: 'Truck',
        drivetrain: '4WD',
      },
      {
        vin: 'DEMO00000000000C2',
        year: 2026,
        make: 'Chevrolet',
        model: 'Silverado 1500',
        trim: 'RST Crew Cab',
        color: 'Black',
        price: 58310,
        bodyType: 'Truck',
        drivetrain: '4WD',
      },
      {
        vin: 'DEMO00000000000C3',
        year: 2026,
        make: 'Chevrolet',
        model: 'Suburban',
        trim: 'LT',
        color: 'Sterling Gray',
        price: 68990,
      },
      {
        vin: 'DEMO00000000000C4',
        year: 2025,
        make: 'Chevrolet',
        model: 'Equinox',
        trim: 'LT',
        color: 'Radiant Red',
        price: 31450,
        drivetrain: 'AWD',
      },
    ],
  },
  nissan: {
    slug: 'dial-nissan-of-chicago',
    name: 'Dial Nissan of Chicago',
    aliases: ['dial nissan'],
    vehicles: [
      {
        vin: 'DEMO0000000000NR1',
        year: 2026,
        make: 'Nissan',
        model: 'Rogue',
        trim: 'SV AWD',
        color: 'Gun Metallic',
        price: 33980,
        drivetrain: 'AWD',
      },
      {
        vin: 'DEMO0000000000NR2',
        year: 2026,
        make: 'Nissan',
        model: 'Rogue',
        trim: 'SL AWD',
        color: 'Pearl White',
        price: 38120,
        drivetrain: 'AWD',
      },
      {
        vin: 'DEMO0000000000NR3',
        year: 2025,
        make: 'Nissan',
        model: 'Altima',
        trim: 'SV',
        color: 'Deep Blue',
        price: 28640,
        bodyType: 'Sedan',
        drivetrain: 'FWD',
      },
    ],
  },
  infiniti: {
    slug: 'infiniti-of-chicago',
    name: 'INFINITI of Chicago',
    aliases: [],
    vehicles: [
      {
        vin: 'DEMO0000000000QX1',
        year: 2026,
        make: 'INFINITI',
        model: 'QX60',
        trim: 'LUXE AWD',
        color: 'Mineral Black',
        price: 58770,
        drivetrain: 'AWD',
      },
      {
        vin: 'DEMO0000000000QX2',
        year: 2026,
        make: 'INFINITI',
        model: 'QX60',
        trim: 'SENSORY AWD',
        color: 'Moonbow Blue',
        price: 64220,
        drivetrain: 'AWD',
      },
      {
        vin: 'DEMO0000000000QX3',
        year: 2025,
        make: 'INFINITI',
        model: 'QX50',
        trim: 'SPORT AWD',
        color: 'Slate Gray',
        price: 49310,
        drivetrain: 'AWD',
      },
    ],
  },
  south: {
    slug: 'dial-cdjr-of-chicago',
    name: 'Dial Chrysler Dodge Jeep Ram of Chicago',
    side: 'south',
    aliases: ['dial jeep', 'dial cdjr', 'dial chrysler dodge jeep ram'],
    vehicles: [
      {
        vin: 'DEMO00000000000S1',
        year: 2026,
        make: 'Jeep',
        model: 'Grand Cherokee',
        trim: 'Limited 4x4',
        color: 'Velvet Red',
        price: 51260,
        drivetrain: '4WD',
      },
      {
        vin: 'DEMO00000000000S2',
        year: 2026,
        make: 'Jeep',
        model: 'Grand Cherokee',
        trim: 'Overland 4x4',
        color: 'Diamond Black',
        price: 62480,
        drivetrain: '4WD',
      },
      {
        vin: 'DEMO00000000000S3',
        year: 2026,
        make: 'Ram',
        model: '1500',
        trim: 'Big Horn Crew Cab',
        color: 'Granite Crystal',
        price: 54130,
        bodyType: 'Truck',
        drivetrain: '4WD',
      },
      {
        vin: 'DEMO00000000000S4',
        year: 2025,
        make: 'Dodge',
        model: 'Durango',
        trim: 'GT AWD',
        color: 'Destroyer Gray',
        price: 46890,
        drivetrain: 'AWD',
      },
      {
        vin: 'DEMO00000000000S5',
        year: 2025,
        make: 'Chrysler',
        model: 'Pacifica',
        trim: 'Touring L',
        color: 'Bright White',
        price: 44350,
        bodyType: 'Van',
        drivetrain: 'FWD',
      },
    ],
  },
  north: {
    slug: 'jeep-of-chicago',
    name: 'Jeep of Chicago',
    side: 'north',
    aliases: [],
    vehicles: [
      {
        vin: 'DEMO00000000000N1',
        year: 2026,
        make: 'Jeep',
        model: 'Grand Cherokee',
        trim: 'Laredo 4x4',
        color: 'Bright White',
        price: 44870,
        drivetrain: '4WD',
      },
      {
        vin: 'DEMO00000000000N2',
        year: 2026,
        make: 'Jeep',
        model: 'Grand Cherokee',
        trim: 'Summit 4x4',
        color: 'Midnight Sky',
        price: 66940,
        drivetrain: '4WD',
      },
      {
        vin: 'DEMO00000000000N3',
        year: 2026,
        make: 'Jeep',
        model: 'Wrangler',
        trim: 'Sahara 4x4',
        color: 'Sarge Green',
        price: 53720,
        drivetrain: '4WD',
      },
      {
        vin: 'DEMO00000000000N4',
        year: 2025,
        make: 'Ram',
        model: '1500',
        trim: 'Laramie Crew Cab',
        color: 'Patriot Blue',
        price: 61580,
        bodyType: 'Truck',
        drivetrain: '4WD',
      },
    ],
  },
};

export const ROOFTOP_FLAGS: Record<string, boolean> = {
  chat: true,
  inventory: true,
  payments: true,
  financeCalculator: true,
  vehicleCompare: true,
  savedVehicles: true,
  leadCapture: true,
  serviceAi: true,
  partsAi: true,
  appointments: true,
  handoff: true,
  multilingual: true,
  knowledge: false,
  sms: false,
  salesDeskCards: true,
  sandboxScheduler: true,
  adfLeadDelivery: true,
  /** This rooftop's own opt-in to appear in its group site's search. */
  groupInventoryListed: true,
};

/** The group site only searches and chats; it holds no leads, appointments or handoffs. */
export const GROUP_SITE_FLAGS: Record<string, boolean> = {
  chat: true,
  inventory: true,
  vehicleCompare: true,
  multilingual: true,
  leadCapture: false,
  handoff: false,
  appointments: false,
  payments: false,
  serviceAi: false,
  partsAi: false,
  knowledge: false,
  groupSiteShopping: true,
};

export type SeededRooftop = {
  key: SeedRooftopKey;
  slug: string;
  name: string;
  tenantId: string;
  locationId: string;
  vins: string[];
};

export type SeededGroup = {
  dealerGroupId: string;
  group: { slug: string; tenantId: string; locationId: string };
  rooftops: Record<SeedRooftopKey, SeededRooftop>;
};

const DEMO_NOTE =
  'Demo: vehicles, prices and hours are simulated. Payment figures are estimates, not offers.';

/**
 * Idempotent. `prefix` namespaces every slug (the e2e suite uses one so it never touches
 * the demo tenants). Lead routes and the sandbox scheduler connection are added by the caller
 * (they need application services) — see scripts/seed-group-rooftops.ts.
 */
export async function seedGroupRooftops(
  prisma: PrismaClient,
  opts: {
    prefix?: string;
    rooftopOrigins: string[];
    groupOrigins: string[];
    rooftopFlags?: Record<string, boolean>;
    groupFlags?: Record<string, boolean>;
  },
): Promise<SeededGroup> {
  const p = opts.prefix ?? '';
  const now = new Date();

  const groupSlug = `${p}${GROUP_SITE.slug}`;
  const dealerGroup = await prisma.dealerGroup.upsert({
    where: { slug: groupSlug },
    create: { slug: groupSlug, name: GROUP_SITE.name },
    update: { name: GROUP_SITE.name },
  });

  const upsertTenant = async (
    slug: string,
    name: string,
    origins: string[],
    featureFlags: Record<string, boolean>,
    publicConfig: Record<string, unknown>,
  ) => {
    const data = {
      name,
      dealerGroupId: dealerGroup.id,
      allowedOrigins: origins.join(','),
      featureFlags,
      publicConfig: publicConfig as object,
    };
    const tenant = await prisma.tenant.upsert({
      where: { slug },
      create: { slug, ...data },
      update: { ...data, configVersion: { increment: 1 } },
    });
    const hours = {
      name,
      timezone: 'America/Chicago',
      storeHours: DEMO_HOURS.storeHours,
      departmentHours: DEMO_HOURS.departmentHours,
      storeHoursVerifiedAt: now,
      storeHoursVerifiedBy: 'synthetic-demo (not real store hours)',
    };
    const location = await prisma.location.upsert({
      where: { tenantId_slug: { tenantId: tenant.id, slug: 'main' } },
      create: { tenantId: tenant.id, slug: 'main', ...hours },
      update: hours,
    });
    return { tenant, location };
  };

  const groupSite = await upsertTenant(
    groupSlug,
    GROUP_SITE.name,
    opts.groupOrigins,
    { ...GROUP_SITE_FLAGS, ...(opts.groupFlags ?? {}) },
    {
      assistantDisplayName: 'Dial Concierge',
      welcomeMessage:
        'Hi! I’m Dial Auto Group’s AI assistant. I can search every Dial store for you — each vehicle shows the store that has it.',
      disclaimerText: DEMO_NOTE,
      primaryColor: '#14213d',
      accentColor: '#ffffff',
      salesEnabled: true,
      serviceEnabled: true,
      partsEnabled: true,
      supportedLocales: ['en', 'es'],
      theme: 'showroom',
    },
  );
  await prisma.dealerGroup.update({
    where: { id: dealerGroup.id },
    data: { groupSiteTenantId: groupSite.tenant.id },
  });

  const rooftops = {} as Record<SeedRooftopKey, SeededRooftop>;
  for (const key of Object.keys(SEED_ROOFTOPS) as SeedRooftopKey[]) {
    const r = SEED_ROOFTOPS[key];
    const slug = `${p}${r.slug}`;
    const { tenant, location } = await upsertTenant(
      slug,
      r.name,
      opts.rooftopOrigins,
      { ...ROOFTOP_FLAGS, ...(opts.rooftopFlags ?? {}) },
      {
        assistantDisplayName: 'Dial Concierge',
        welcomeMessage: `Hi! I’m the AI assistant for ${r.name}. Ask me about vehicles, payments, service or parts.`,
        disclaimerText: DEMO_NOTE,
        primaryColor: '#14213d',
        accentColor: '#ffffff',
        salesEnabled: true,
        serviceEnabled: true,
        partsEnabled: true,
        supportedLocales: ['en', 'es'],
        theme: 'showroom',
        ...(r.side ? { groupSide: r.side } : {}),
        ...(r.aliases.length ? { groupAliases: r.aliases } : {}),
      },
    );
    for (const v of r.vehicles) {
      const data = {
        tenantId: tenant.id,
        locationId: location.id,
        vin: v.vin,
        stock: `DEMO-${v.vin.slice(-3)}`,
        year: v.year,
        make: v.make,
        model: v.model,
        trim: v.trim,
        bodyType: v.bodyType ?? 'SUV',
        drivetrain: v.drivetrain ?? '4WD',
        transmission: 'Automatic',
        fuelType: 'Gasoline',
        color: v.color,
        price: v.price,
        msrp: null,
        mileage: v.mileage ?? 8,
        condition: v.condition ?? 'new',
        features: [] as string[],
        photos: [] as string[],
        status: 'AVAILABLE' as const,
        source: 'synthetic_demo',
        lastSeenAt: now,
        sourceTimestamp: now,
        freshnessState: 'FRESH' as const,
        rawSource: {
          note: 'SIMULATED demo fixture — not dealership inventory',
        },
      };
      await prisma.vehicle.upsert({
        where: { tenantId_vin: { tenantId: tenant.id, vin: v.vin } },
        create: data,
        update: data,
      });
    }
    rooftops[key] = {
      key,
      slug,
      name: r.name,
      tenantId: tenant.id,
      locationId: location.id,
      vins: r.vehicles.map((v) => v.vin),
    };
  }

  return {
    dealerGroupId: dealerGroup.id,
    group: {
      slug: groupSlug,
      tenantId: groupSite.tenant.id,
      locationId: groupSite.location.id,
    },
    rooftops,
  };
}

/** SANDBOX (demo) scheduler connection for one rooftop. Idempotent. */
export async function ensureSandboxSchedulerConnection(
  prisma: PrismaClient,
  tenantId: string,
  locationId: string,
) {
  const data = {
    enabled: true,
    liveReady: true,
    config: {
      mode: 'sandbox',
      note: 'SANDBOX demo scheduler — not a real DMS',
    },
  };
  const existing = await prisma.integrationConnection.findFirst({
    where: {
      tenantId,
      locationId,
      provider: 'MOCK',
      capability: 'appointments',
    },
    select: { id: true },
  });
  if (existing)
    await prisma.integrationConnection.update({
      where: { id: existing.id },
      data,
    });
  else
    await prisma.integrationConnection.create({
      data: {
        tenantId,
        locationId,
        provider: 'MOCK',
        capability: 'appointments',
        ...data,
      },
    });
}
