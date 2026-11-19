/**
 * LOCAL DEMO ONLY — gives the disposable demo rooftop a SANDBOX ADF lead route so a lead captured
 * in the demo chat travels the real delivery pipeline to the loopback mock SMTP sink.
 *
 *   set -a; . ./test-infra/.env.test; set +a
 *   npm run seed:local-demo && npm run seed:local-demo:lead-route
 *
 * The route points at a reserved example.invalid address, is marked SANDBOX (so it can never be
 * production-enabled) and is "verified" only in the sandbox sense recorded in its evidence
 * text. Refuses a non-local database or NODE_ENV=production. No real mailbox is ever addressed.
 */
import { isProductionTier } from '../src/config/deployment-tier';
function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function main() {
  const dbHost = new URL(process.env.DATABASE_URL ?? 'postgres://x@invalid/x')
    .hostname;
  if (!['127.0.0.1', 'localhost'].includes(dbHost))
    fail(`Refusing to run: DATABASE_URL host '${dbHost}' is not local.`);
  if (isProductionTier())
    fail('Refusing to run in the production deployment tier.');
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

  const tenantSlug = process.env.DEMO_TENANT_SLUG ?? 'dial-demo-local';
  const locationSlug = process.env.DEMO_LOCATION_SLUG ?? 'demo-rooftop';
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const prisma = app.get(PrismaService);
    const tenant = await prisma.tenant.findUnique({
      where: { slug: tenantSlug },
    });
    if (!tenant)
      fail(`Tenant '${tenantSlug}' not found — run seed:local-demo.`);
    const location = await prisma.location.findUnique({
      where: { tenantId_slug: { tenantId: tenant.id, slug: locationSlug } },
    });
    if (!location) fail(`Location '${locationSlug}' not found.`);
    const flags = (location.featureFlags ?? {}) as Record<string, unknown>;
    await prisma.location.update({
      where: { id: location.id },
      data: { featureFlags: { ...flags, adfLeadDelivery: true } },
    });
    const seeded = await seedSandboxRoutes(
      app.get(LeadDeliveryRouteService),
      [{ tenantId: tenant.id, locationId: location.id, slug: tenantSlug }],
      'cli:seed-local-demo-lead-route',
    );
    console.log(
      JSON.stringify(
        {
          tenantSlug,
          locationSlug,
          route: 'SANDBOX',
          address: seeded[0]?.address,
          note: 'Reserved test address. ACCEPTED by the mock is not delivery and not a CRM record.',
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
