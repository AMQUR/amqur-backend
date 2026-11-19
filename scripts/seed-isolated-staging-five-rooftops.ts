/**
 * ISOLATED STAGING ONLY — five SYNTHETIC rooftops + group site + staff admin for canary.
 *
 * Fail-closed: see src/config/isolated-staging-seed-gate.ts.
 * Does not weaken npm run seed:group-rooftops (still loopback-only).
 *
 * On Railway (inside backend-staging container):
 *   ISOLATED_STAGING_SEED_ENABLED=true npm run seed:isolated-staging
 */
import * as bcrypt from 'bcryptjs';
import { Role } from '@prisma/client';
import { assertIsolatedStagingSeedAllowed } from '../src/config/isolated-staging-seed-gate';

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function loadDist<T>(rel: string): T {
  // Prefer compiled Nest output when running inside the Railway image.
  try {
    return require(`../dist/${rel}`) as T;
  } catch {
    return require(`../src/${rel}`) as T;
  }
}

async function main() {
  let gate: { dbHost: string; projectId: string; tier: string };
  try {
    gate = assertIsolatedStagingSeedAllowed();
  } catch (e) {
    fail(e instanceof Error ? e.message : 'seed gate failed');
  }

  process.env.OUTBOX_PROCESSOR_ENABLED = 'false';
  process.env.INVENTORY_SYNC_ENABLED = 'false';
  process.env.ADF_SEND_ENABLED = 'false';

  const widgetOrigin =
    process.env.ISOLATED_STAGING_WIDGET_ORIGIN?.trim() ||
    'https://widget-staging-staging.up.railway.app';
  const groupPreviewOrigin =
    process.env.ISOLATED_STAGING_GROUP_PREVIEW_ORIGIN?.trim() || '';
  const rooftopOrigins = [widgetOrigin];
  const groupOrigins = [widgetOrigin, groupPreviewOrigin].filter(Boolean);

  const { NestFactory } =
    require('@nestjs/core') as typeof import('@nestjs/core');
  const { AppModule } = loadDist<{ AppModule: unknown }>('app.module');
  const { PrismaService } = loadDist<{
    PrismaService: new () => import('../src/prisma/prisma.service').PrismaService;
  }>('prisma/prisma.service');
  const { LeadDeliveryRouteService } = loadDist<{
    LeadDeliveryRouteService: new (
      ...args: never[]
    ) => import('../src/integrations/adf/lead-delivery-route.service').LeadDeliveryRouteService;
  }>('integrations/adf/lead-delivery-route.service');
  const { seedSandboxRoutes } = loadDist<{
    seedSandboxRoutes: typeof import('../src/integrations/adf/sandbox-routes.seed').seedSandboxRoutes;
  }>('integrations/adf/sandbox-routes.seed');
  const { seedGroupRooftops, ensureSandboxSchedulerConnection } =
    require('./lib/group-rooftops-seed') as typeof import('./lib/group-rooftops-seed');

  const app = await NestFactory.createApplicationContext(AppModule as never, {
    logger: ['error', 'warn'],
  });
  try {
    const prisma = app.get(PrismaService);
    const seeded = await seedGroupRooftops(prisma, {
      rooftopOrigins,
      groupOrigins,
    });
    const rooftops = Object.values(seeded.rooftops);
    for (const r of rooftops)
      await ensureSandboxSchedulerConnection(prisma, r.tenantId, r.locationId);
    const routes = await seedSandboxRoutes(
      app.get(LeadDeliveryRouteService),
      rooftops.map((r) => ({
        tenantId: r.tenantId,
        locationId: r.locationId,
        slug: r.slug,
      })),
      'cli:seed-isolated-staging',
    );

    const email = process.env.STAGING_ADMIN_EMAIL?.trim().toLowerCase();
    const password = process.env.STAGING_ADMIN_PASSWORD;
    let staff = 'skipped (set STAGING_ADMIN_EMAIL and STAGING_ADMIN_PASSWORD)';
    if (email && password) {
      if (password.length < 12)
        fail('STAGING_ADMIN_PASSWORD must be at least 12 characters.');
      const hash = await bcrypt.hash(password, 12);
      const groupTenantId = seeded.group.tenantId;
      await prisma.user.upsert({
        where: { tenantId_email: { tenantId: groupTenantId, email } },
        create: {
          tenantId: groupTenantId,
          email,
          password: hash,
          firstName: 'Staging',
          lastName: 'Admin',
          role: Role.SUPER_ADMIN,
        },
        update: {
          password: hash,
          isActive: true,
          role: Role.SUPER_ADMIN,
        },
      });
      staff = `SUPER_ADMIN ${email} on ${seeded.group.slug}`;
    }

    console.log(
      JSON.stringify(
        {
          gate,
          groupSite: seeded.group.slug,
          location: 'main',
          rooftops: rooftops.map((r) => ({
            slug: r.slug,
            name: r.name,
            vehicles: r.vins.length,
            leadRoute: routes.find((x) => x.slug === r.slug)?.address,
          })),
          origins: { rooftopOrigins, groupOrigins },
          inventory: 'SIMULATED (source=synthetic_demo)',
          leadRoutes: 'SANDBOX example.invalid only',
          scheduler: 'SANDBOX (SBX- labels; not a real scheduler)',
          staff,
          note: 'Isolated staging synthetic seed — not customer data',
        },
        null,
        2,
      ),
    );
  } finally {
    await app.close();
  }
}

void main().catch((e) => {
  console.error(e instanceof Error ? e.message : 'seed failed');
  process.exit(1);
});
