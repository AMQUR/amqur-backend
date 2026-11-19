/**
 * LOCAL / DEMO / TEST ONLY — five SYNTHETIC rooftop tenants plus the group-site tenant, for
 * trying group-site rooftop routing (docs/GROUP_ROOFTOP_ROUTING.md) and running the golden
 * evaluation set with one tenant per rooftop slug.
 *
 *   set -a; . ./test-infra/.env.test; set +a        # or your own local DATABASE_URL
 *   npx prisma migrate deploy
 *   npm run seed:group-rooftops
 *
 * Creates (idempotent): tenants dial-chevy-of-chicago, dial-nissan-of-chicago,
 * infiniti-of-chicago, dial-cdjr-of-chicago (South Side), jeep-of-chicago (North Side) — each
 * with location `main`, simulated inventory (source=synthetic_demo), the sandbox scheduler and
 * a SANDBOX lead route to its own example.invalid address — plus dial-auto-group, the
 * DealerGroup that links them and designates dial-auto-group as its group site, with
 * `groupSiteShopping` on it and `groupInventoryListed` on every rooftop.
 *
 * Refuses a non-local database or NODE_ENV=production. No real mailbox is ever addressed.
 */
function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function main() {
  const dbHost = new URL(process.env.DATABASE_URL ?? 'postgres://x@invalid/x')
    .hostname;
  if (!['127.0.0.1', 'localhost'].includes(dbHost))
    fail(`Refusing to run: DATABASE_URL host '${dbHost}' is not local.`);
  if (process.env.NODE_ENV === 'production')
    fail('Refusing to run with NODE_ENV=production.');
  process.env.OUTBOX_PROCESSOR_ENABLED = 'false';
  process.env.INVENTORY_SYNC_ENABLED = 'false';

  const { NestFactory } =
    require('@nestjs/core') as typeof import('@nestjs/core');
  const { AppModule } =
    require('../src/app.module') as typeof import('../src/app.module');
  const { PrismaService } =
    require('../src/prisma/prisma.service') as typeof import('../src/prisma/prisma.service');
  const { LeadDeliveryRouteService } =
    require('../src/integrations/adf/lead-delivery-route.service') as typeof import('../src/integrations/adf/lead-delivery-route.service');
  const { seedSandboxRoutes } =
    require('../src/integrations/adf/sandbox-routes.seed') as typeof import('../src/integrations/adf/sandbox-routes.seed');
  const { seedGroupRooftops, ensureSandboxSchedulerConnection } =
    require('./lib/group-rooftops-seed') as typeof import('./lib/group-rooftops-seed');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const prisma = app.get(PrismaService);
    const seeded = await seedGroupRooftops(prisma, {
      rooftopOrigins: ['http://localhost:5173'],
      groupOrigins: ['http://localhost:5173', 'http://localhost:3000'],
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
      'cli:seed-group-rooftops',
    );
    console.log(
      JSON.stringify(
        {
          groupSite: seeded.group.slug,
          location: 'main',
          rooftops: rooftops.map((r) => ({
            slug: r.slug,
            name: r.name,
            vehicles: r.vins.length,
            leadRoute: routes.find((x) => x.slug === r.slug)?.address,
          })),
          inventory: 'SIMULATED (source=synthetic_demo)',
          scheduler:
            'SANDBOX demo scheduler (SBX- references; not a real scheduler)',
          leadRoutes:
            'SANDBOX, reserved example.invalid addresses. Not delivery to a dealership CRM.',
          flags:
            'groupSiteShopping on the group site; groupInventoryListed on each rooftop',
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
