/**
 * CRM WORKFORCE — LOCAL DEMO seed. Disposable local database only; refused in production and
 * against any non-loopback database.
 *
 *   set -a && . ./test-infra/.env.test && set +a
 *   npx prisma migrate deploy
 *   DEMO_ADMIN_EMAIL=you@example.com DEMO_ADMIN_PASSWORD='…' npm run seed:crm-workforce-demo
 *
 * Creates one clearly synthetic rooftop ("CRM Workforce Demo Motors") with SYNTHETIC leads —
 * reserved 555-01xx numbers and example.invalid addresses, never a real person — covering
 * each queue, and runs the real supervisor over them with a CANNED model reply (no model
 * spend). Everything it creates is labelled DEMO in the Command Center. It does not enable
 * customer sending: the deployment switch CRM_WORKFORCE_EXTERNAL_SEND_ENABLED stays unset.
 */
import { NestFactory } from '@nestjs/core';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../src/app.module';
import { LlmRouterService } from '../src/ai/llm-router.service';
import { isProductionTier } from '../src/config/deployment-tier';
import { CrmLeadRecord } from '../src/crm-workforce/adapters/crm-adapter';
import { CrmWfEngineService } from '../src/crm-workforce/engine.service';
import { CrmWfIntakeService } from '../src/crm-workforce/intake.service';
import { PrismaService } from '../src/prisma/prisma.service';

const SLUG = 'crm-workforce-demo';
const h = (hours: number) =>
  new Date(Date.now() - hours * 3_600_000).toISOString();

function lead(
  n: number,
  p: Partial<CrmLeadRecord> & {
    inbound?: string;
    outAgo?: number;
    inAgo?: number;
  },
): CrmLeadRecord {
  const id = `DEMO-${n}`;
  const messages: CrmLeadRecord['messages'] = [];
  if (p.outAgo !== undefined)
    messages.push({
      sourceRecordId: `${id}-o`,
      direction: 'OUTBOUND',
      channel: 'SMS',
      authorType: 'STAFF',
      body: 'Thanks for your interest — let us know how we can help.',
      occurredAt: h(p.outAgo),
    });
  if (p.inbound)
    messages.push({
      sourceRecordId: `${id}-i`,
      direction: 'INBOUND',
      channel: 'SMS',
      authorType: 'CUSTOMER',
      body: p.inbound,
      occurredAt: h(p.inAgo ?? 1),
    });
  const { inbound: _a, outAgo: _b, inAgo: _c, ...rest } = p;
  return {
    sourceRecordId: id,
    asOf: new Date().toISOString(),
    verified: false,
    synthetic: true,
    department: 'SALES',
    firstName: 'Demo',
    lastName: `Customer ${n}`,
    phone: `+131255501${String(n).padStart(2, '0')}`,
    email: `demo${n}@example.invalid`,
    leadSource: 'Demo website form',
    crmStatus: 'Active',
    assignedTo: 'Demo Salesperson',
    createdInCrmAt: h(30),
    vehicleInterest: { year: 2026, make: 'Demo', model: 'Sedan' },
    doNotContact: false,
    messages,
    ...rest,
  };
}

async function main() {
  const dbHost = new URL(process.env.DATABASE_URL ?? 'postgres://x@invalid/x')
    .hostname;
  if (!['127.0.0.1', 'localhost'].includes(dbHost) || isProductionTier()) {
    console.error(
      'Refusing: the CRM Workforce demo seed runs only against a local, non-production database.',
    );
    process.exit(1);
  }
  process.env.CRM_WORKFORCE_ENABLED = 'true';
  process.env.OUTBOX_PROCESSOR_ENABLED = 'false';
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });
  const prisma = app.get(PrismaService);
  // Canned replies instead of a model: this is a demo of the pipeline, not of model quality.
  let i = 0;
  const canned = [
    "This is Morgan, the dealership's virtual assistant. I can have the team confirm that for you — is a text back fine?",
    "This is Morgan, the dealership's virtual assistant. Would a call from your salesperson this afternoon work?",
  ];
  (app.get(LlmRouterService) as unknown as { route: unknown }).route =
    async () => ({
      ok: true,
      attempts: 1,
      result: {
        text: canned[i++ % canned.length],
        provider: 'demo-canned',
        model: 'none',
        latencyMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        costMicroUsd: 0,
      },
    });

  const tenant = await prisma.tenant.upsert({
    where: { slug: SLUG },
    create: {
      slug: SLUG,
      name: 'CRM Workforce Demo Motors (synthetic)',
      featureFlags: { crmWorkforce: true },
    },
    update: { featureFlags: { crmWorkforce: true } },
  });
  const loc = await prisma.location.upsert({
    where: { tenantId_slug: { tenantId: tenant.id, slug: 'main' } },
    create: {
      tenantId: tenant.id,
      slug: 'main',
      name: 'Demo Motors — main (synthetic)',
      timezone: 'America/Chicago',
    },
    update: {},
  });
  const scope = { tenantId: tenant.id, locationId: loc.id };

  const email = process.env.DEMO_ADMIN_EMAIL,
    password = process.env.DEMO_ADMIN_PASSWORD;
  if (email && password) {
    const hash = await bcrypt.hash(password, 10);
    await prisma.user.upsert({
      where: { tenantId_email: { tenantId: tenant.id, email } },
      create: {
        tenantId: tenant.id,
        email,
        password: hash,
        firstName: 'Demo',
        lastName: 'Admin',
        role: Role.ADMIN,
      },
      update: { password: hash, isActive: true },
    });
  }

  for (const m of [
    'crmWfWorkItem',
    'crmWfImportChange',
    'crmWfImportBatch',
    'crmWfReview',
    'crmWfOutcome',
    'crmWfUsage',
    'crmWfAction',
    'crmWfTask',
    'crmWfMessage',
    'crmWfLead',
    'crmWfSuppression',
    'crmWfControl',
    'crmWfConnector',
    'crmWfAgentProfile',
  ] as const)
    await (
      prisma[m] as unknown as { deleteMany: (a: object) => Promise<unknown> }
    ).deleteMany({ where: { tenantId: tenant.id } });
  await prisma.consentRecord.deleteMany({ where: { tenantId: tenant.id } });

  await prisma.crmWfControl.create({
    data: {
      scope: 'LOCATION',
      scopeKey: `L:${tenant.id}:${loc.id}`,
      tenantId: tenant.id,
      locationId: loc.id,
      mode: 'SUPERVISED',
      externalSendEnabled: false,
      reason: 'demo seed',
    },
  });
  await prisma.crmWfAgentProfile.create({
    data: {
      ...scope,
      department: 'SALES',
      displayName: 'Morgan',
      title: 'Virtual BDC Manager',
      disclosure: 'Morgan, the virtual BDC manager at Demo Motors',
    },
  });
  await prisma.crmWfConnector.create({
    data: {
      ...scope,
      adapterKey: 'fixture',
      enabled: true,
      status: 'READY',
      statusReason: 'synthetic_data',
    },
  });

  const records = [
    lead(1, { inbound: 'Is the sedan still available?', outAgo: 6 }),
    lead(2, {
      inbound: 'Can someone call me about it today?',
      outAgo: 8,
      inAgo: 2,
    }),
    lead(3, {
      inbound: 'I need to reschedule my appointment',
      outAgo: 20,
      appointmentState: 'SCHEDULED',
      appointmentAt: h(-20),
    }),
    lead(4, {}),
    lead(5, {
      department: 'SERVICE',
      leadSource: 'Demo service form',
      vehicleInterest: null,
    }),
    lead(6, { inbound: "What's your best price out the door?", outAgo: 5 }),
    lead(7, { inbound: 'I want to talk to a real person', outAgo: 5 }),
    lead(8, { inbound: 'STOP', outAgo: 5 }),
    lead(9, {
      createdInCrmAt: h(24 * 10),
      outAgo: 24 * 3,
      appointmentState: 'MISSED',
      appointmentAt: h(24 * 2),
    }),
    lead(10, { createdInCrmAt: h(24 * 90), outAgo: 24 * 80 }),
    lead(11, {
      department: 'PARTS',
      inbound: 'Do you have floor mats for it?',
      outAgo: 4,
      vehicleInterest: null,
    }),
  ];
  // Synthetic consent for the two customers whose replies should reach "ready to approve".
  for (const n of [1, 2])
    await prisma.consentRecord.create({
      data: {
        tenantId: tenant.id,
        channel: 'SMS',
        endpoint: records[n - 1].phone!,
        purpose: 'CONVERSATIONAL',
        granted: true,
        source: 'IMPORT',
        wording: 'synthetic demo consent',
        wordingVersion: 'demo',
      },
    });

  const summary = await app
    .get(CrmWfIntakeService)
    .ingest(scope, 'fixture', records);
  const tick = await app.get(CrmWfEngineService).tick();
  console.log(JSON.stringify({ tenant: SLUG, summary, tick }, null, 2));
  console.log(
    email
      ? `Sign in at /cc/ as ${email} (tenant ${SLUG}).`
      : 'No staff login created (set DEMO_ADMIN_EMAIL and DEMO_ADMIN_PASSWORD).',
  );
  await app.close();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
