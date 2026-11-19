/**
 * LOCAL SANDBOX DEMO — per-rooftop ADF/XML lead delivery. Disposable local database only.
 *
 *   npm run test:infra:up
 *   set -a && . ./test-infra/.env.test && set +a
 *   npx prisma migrate deploy
 *   npm run adf:sandbox-demo                 # in-process sandbox sink
 *   npm run adf:sandbox-demo -- --smtp       # loopback mock SMTP (127.0.0.1:11025)
 *
 * What it does (idempotent):
 *  - ensures the five rooftop tenants from config/rooftops/registry.json exist LOCALLY, each
 *    with location `main` and the `adfLeadDelivery` flag on;
 *  - gives each a SANDBOX route to its own reserved address (*.example.invalid);
 *  - creates one SYNTHETIC lead per rooftop (example.invalid email, 555-01xx phone),
 *    enqueues it and drains the outbox;
 *  - prints, per rooftop, the delivery status and which sink address received it.
 *
 * It refuses to run against a non-local database or with NODE_ENV=production, never reads the
 * operator's recipient candidates, and can never address a real mailbox.
 */
import * as fs from 'fs';
import * as path from 'path';

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
  const useSmtp = process.argv.includes('--smtp');
  process.env.ADF_SEND_ENABLED = 'true';
  process.env.LEAD_DELIVERY_MODE = 'sandbox';
  process.env.ADF_SANDBOX_TRANSPORT = useSmtp ? 'smtp' : 'sink';
  process.env.OUTBOX_PROCESSOR_ENABLED = 'false';
  process.env.INVENTORY_SYNC_ENABLED = 'false';

  // Imported after the env is pinned so nothing reads a live setting.
  const { NestFactory } =
    require('@nestjs/core') as typeof import('@nestjs/core');
  const { AppModule } =
    require('../src/app.module') as typeof import('../src/app.module');
  const { PrismaService } =
    require('../src/prisma/prisma.service') as typeof import('../src/prisma/prisma.service');
  const { OutboxProcessorService } =
    require('../src/integrations/core/outbox-processor.service') as typeof import('../src/integrations/core/outbox-processor.service');
  const { LeadDeliveryService } =
    require('../src/integrations/adf/lead-delivery.service') as typeof import('../src/integrations/adf/lead-delivery.service');
  const { LeadDeliveryRouteService } =
    require('../src/integrations/adf/lead-delivery-route.service') as typeof import('../src/integrations/adf/lead-delivery-route.service');
  const { SandboxSinkTransport } =
    require('../src/integrations/adf/transports/sandbox-sink.transport') as typeof import('../src/integrations/adf/transports/sandbox-sink.transport');
  const { seedSandboxRoutes } =
    require('../src/integrations/adf/sandbox-routes.seed') as typeof import('../src/integrations/adf/sandbox-routes.seed');

  const registry = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, '../config/rooftops/registry.json'),
      'utf8',
    ),
  ) as {
    rooftops: Array<{
      displayName: string;
      tenantSlug: string;
      locationSlug: string;
    }>;
  };

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const prisma = app.get(PrismaService);
    const rooftops: Array<{
      tenantId: string;
      locationId: string;
      slug: string;
    }> = [];
    for (const r of registry.rooftops) {
      const tenant = await prisma.tenant.upsert({
        where: { slug: r.tenantSlug },
        create: { slug: r.tenantSlug, name: r.displayName },
        update: {},
      });
      const location = await prisma.location.upsert({
        where: {
          tenantId_slug: { tenantId: tenant.id, slug: r.locationSlug },
        },
        create: {
          tenantId: tenant.id,
          slug: r.locationSlug,
          name: r.displayName,
        },
        update: {},
      });
      const flags = (location.featureFlags ?? {}) as Record<string, unknown>;
      await prisma.location.update({
        where: { id: location.id },
        data: { featureFlags: { ...flags, adfLeadDelivery: true } },
      });
      rooftops.push({
        tenantId: tenant.id,
        locationId: location.id,
        slug: r.tenantSlug,
      });
    }
    const seeded = await seedSandboxRoutes(
      app.get(LeadDeliveryRouteService),
      rooftops,
      'cli:adf-sandbox-demo',
    );

    const deliveries = app.get(LeadDeliveryService);
    const ids: Array<{ slug: string; deliveryId: string }> = [];
    for (const [i, r] of rooftops.entries()) {
      const lead = await prisma.lead.create({
        data: {
          tenantId: r.tenantId,
          locationId: r.locationId,
          firstName: 'Synthetic',
          lastName: `Demo ${i + 1}`,
          email: `synthetic-demo-${i + 1}-${Date.now()}@example.invalid`,
          phone: `312-555-01${String(10 + i)}`,
          source: 'adf_sandbox_demo',
        },
      });
      const res = await deliveries.enqueueForLead(r.tenantId, lead.id);
      if (res.status !== 'skipped')
        ids.push({ slug: r.slug, deliveryId: res.deliveryId });
    }
    const processor = app.get(OutboxProcessorService);
    for (let i = 0; i < 20; i += 1) {
      const open = await prisma.leadDelivery.count({
        where: {
          id: { in: ids.map((x) => x.deliveryId) },
          status: { in: ['QUEUED', 'SENT'] },
        },
      });
      if (open === 0) break;
      await processor.processBatch(500, 'adf-sandbox-demo');
    }

    const sink = app.get(SandboxSinkTransport).messages();
    console.log(
      `\nADF sandbox demo — transport=${useSmtp ? 'mock SMTP 127.0.0.1' : 'sandbox sink'}  (ACCEPTED = transport acknowledged; NOT delivered, NOT in a CRM)\n`,
    );
    for (const x of ids) {
      const d = await prisma.leadDelivery.findUniqueOrThrow({
        where: { id: x.deliveryId },
      });
      const expected = seeded.find((s) => s.slug === x.slug);
      const landed = useSmtp
        ? '(see GET http://127.0.0.1:18085/messages)'
        : (sink.find((m) => m.deliveryId === d.id)?.to ?? '—');
      console.log(
        `${x.slug.padEnd(26)} ${d.status.padEnd(9)} provider=${d.providerName ?? '—'}  route=${expected?.address}  landed=${landed}`,
      );
    }
    console.log('');
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : 'adf sandbox demo failed');
  process.exit(1);
});
