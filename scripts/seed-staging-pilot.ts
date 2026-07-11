/**
 * Staging pilot seed — creates Dial Auto Group staging tenant + one rooftop.
 *
 * Usage (against STAGING database only):
 *   DATABASE_URL=... npx ts-node --transpile-only scripts/seed-staging-pilot.ts
 *
 * Does NOT enable Tekion, automated follow-up, or voice.
 * Does NOT configure a live vAuto URL unless STAGING_VAUTO_FEED_URL is set.
 */
import { PrismaClient, IntegrationProvider } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

async function main() {
  const flagsPath = path.join(__dirname, '../config/staging-pilot.flags.json');
  const cfg = JSON.parse(fs.readFileSync(flagsPath, 'utf8')) as {
    tenantSlug: string;
    tenantName: string;
    locationSlug: string;
    locationName: string;
    timezone: string;
    featureFlags: Record<string, boolean>;
  };

  const feedUrl = process.env.STAGING_VAUTO_FEED_URL?.trim() || null;
  const useLiveFeed = Boolean(feedUrl);
  const featureFlags = {
    ...cfg.featureFlags,
    vAutoFeed: useLiveFeed,
    tekionIntegration: false,
    automatedFollowup: false,
    voiceAi: false,
  };

  const stagingOrigins =
    process.env.STAGING_ALLOWED_ORIGINS?.trim() ||
    process.env.CORS_ORIGINS?.trim() ||
    null;

  const tenant = await prisma.tenant.upsert({
    where: { slug: cfg.tenantSlug },
    create: {
      slug: cfg.tenantSlug,
      name: cfg.tenantName,
      featureFlags,
      allowedOrigins: stagingOrigins,
    },
    update: {
      name: cfg.tenantName,
      featureFlags,
      ...(stagingOrigins ? { allowedOrigins: stagingOrigins } : {}),
    },
  });

  const location = await prisma.location.upsert({
    where: {
      tenantId_slug: { tenantId: tenant.id, slug: cfg.locationSlug },
    },
    create: {
      tenantId: tenant.id,
      slug: cfg.locationSlug,
      name: cfg.locationName,
      timezone: cfg.timezone,
      featureFlags,
      inventoryFeedUrl: feedUrl,
      inventoryFeedType: feedUrl ? 'XML' : null,
      inventoryMinRecords: 1,
      inventoryFreshnessHours: 24,
      externalIds: { pilot: true, group: 'dial-auto-group' },
    },
    update: {
      name: cfg.locationName,
      featureFlags,
      inventoryFeedUrl: feedUrl,
      inventoryFeedType: feedUrl ? 'XML' : null,
    },
  });

  // Explicitly ensure Tekion connection exists but disabled / not liveReady
  await prisma.integrationConnection.upsert({
    where: {
      tenantId_locationId_provider_capability: {
        tenantId: tenant.id,
        locationId: location.id,
        provider: IntegrationProvider.TEKION,
        capability: 'crm',
      },
    },
    create: {
      tenantId: tenant.id,
      locationId: location.id,
      provider: IntegrationProvider.TEKION,
      capability: 'crm',
      enabled: false,
      liveReady: false,
      healthStatus: 'DISABLED',
      config: { note: 'Pilot: Tekion disabled until partner credentials' },
    },
    update: {
      enabled: false,
      liveReady: false,
      healthStatus: 'DISABLED',
    },
  });

  await prisma.integrationConnection.upsert({
    where: {
      tenantId_locationId_provider_capability: {
        tenantId: tenant.id,
        locationId: location.id,
        provider: IntegrationProvider.VAUTO,
        capability: 'inventory_feed',
      },
    },
    create: {
      tenantId: tenant.id,
      locationId: location.id,
      provider: IntegrationProvider.VAUTO,
      capability: 'inventory_feed',
      enabled: useLiveFeed,
      liveReady: useLiveFeed,
      healthStatus: useLiveFeed ? 'UNKNOWN' : 'DISABLED',
      config: {
        transport: 'HTTPS',
        mode: useLiveFeed ? 'authorized_feed' : 'fixture_only',
        fixturePath: 'fixtures/vauto/staging-inventory.fixture.xml',
      },
    },
    update: {
      enabled: useLiveFeed,
      liveReady: useLiveFeed,
      healthStatus: useLiveFeed ? 'UNKNOWN' : 'DISABLED',
    },
  });

  // Seed fixture vehicles when no live feed (tenant-scoped demo inventory)
  if (!useLiveFeed) {
    const fixtures = [
      {
        vin: '1C4RJFBG0JC123456',
        stock: 'STG1001',
        year: 2024,
        make: 'Jeep',
        model: 'Wrangler',
        trim: 'Sport',
        price: 42995,
        mileage: 12000,
      },
      {
        vin: '1C4RJFAG5PC654321',
        stock: 'STG1002',
        year: 2023,
        make: 'Jeep',
        model: 'Grand Cherokee',
        trim: 'Laredo',
        price: 38995,
        mileage: 18500,
      },
    ];
    for (const v of fixtures) {
      await prisma.vehicle.upsert({
        where: { tenantId_vin: { tenantId: tenant.id, vin: v.vin } },
        create: {
          tenantId: tenant.id,
          locationId: location.id,
          ...v,
          status: 'AVAILABLE',
          source: 'staging_fixture',
          freshnessState: 'FRESH',
          lastSeenAt: new Date(),
        },
        update: {
          locationId: location.id,
          stock: v.stock,
          price: v.price,
          mileage: v.mileage,
          status: 'AVAILABLE',
          source: 'staging_fixture',
          freshnessState: 'FRESH',
          lastSeenAt: new Date(),
        },
      });
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        locationId: location.id,
        locationSlug: location.slug,
        vAutoLiveFeed: useLiveFeed,
        tekionEnabled: false,
        automatedFollowup: false,
        voiceAi: false,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
