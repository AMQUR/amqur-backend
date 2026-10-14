/**
 * LOCAL OWNER DEMO seed — disposable local database only.
 *
 *   set -a && . ./test-infra/.env.test && set +a      # local Postgres/Redis (never Railway)
 *   npx prisma migrate deploy
 *   npm run seed:local-demo
 *   # optional staff login for the Command Center (credentials come from YOUR shell, never Git):
 *   DEMO_ADMIN_EMAIL=you@example.com DEMO_ADMIN_PASSWORD='…' npm run seed:local-demo
 *
 * What it creates (idempotent):
 *  - tenant/location from config/local-demo.flags.json with appointments REQUESTS enabled
 *  - synthetic, clearly labeled demo hours (storeHoursVerifiedBy = "synthetic-demo …")
 *  - SIMULATED inventory (source = synthetic_demo): VINs contain the letter "O", which a real
 *    VIN can never contain; no photos (no stock imagery is ever attached to a fixture)
 *  - an ILLUSTRATIVE financial policy (no tax/fee rules → OTD totals are staff-quoted)
 *
 * It never configures a credit-application destination; use `npm run credit:destination`.
 */
import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

import {
  DEMO_HOURS as HOURS,
  DEMO_VEHICLES as VEHICLES,
} from './lib/local-demo-data';

async function main() {
  const dbHost = new URL(process.env.DATABASE_URL ?? 'postgres://x@invalid/x')
    .hostname;
  if (!['127.0.0.1', 'localhost'].includes(dbHost)) {
    console.error(
      `Refusing to seed demo data: DATABASE_URL host '${dbHost}' is not local.`,
    );
    process.exit(1);
  }
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to seed demo data with NODE_ENV=production.');
    process.exit(1);
  }
  const cfg = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, '../config/local-demo.flags.json'),
      'utf8',
    ),
  ) as {
    tenantSlug: string;
    tenantName: string;
    locationSlug: string;
    locationName: string;
    timezone: string;
    allowedOrigins: string[];
    featureFlags: Record<string, boolean>;
  };

  const publicConfig = {
    assistantDisplayName: 'Dial Concierge',
    welcomeMessage:
      'Hi! I’m the dealership’s AI assistant. Ask me about vehicles, payments, service or parts.',
    disclaimerText:
      'Local demo: vehicles, prices and hours are simulated. Payment figures are estimates, not offers.',
    escalationMessage: 'I can pass this to the team so a person follows up.',
    primaryColor: '#14213d',
    accentColor: '#c8102e',
    salesEnabled: true,
    serviceEnabled: true,
    partsEnabled: true,
    supportedLocales: ['en', 'es'],
  };

  const tenant = await prisma.tenant.upsert({
    where: { slug: cfg.tenantSlug },
    create: {
      slug: cfg.tenantSlug,
      name: cfg.tenantName,
      featureFlags: cfg.featureFlags,
      allowedOrigins: cfg.allowedOrigins.join(','),
      publicConfig,
    },
    update: {
      name: cfg.tenantName,
      featureFlags: cfg.featureFlags,
      allowedOrigins: cfg.allowedOrigins.join(','),
      publicConfig,
      configVersion: { increment: 1 },
    },
  });

  const location = await prisma.location.upsert({
    where: { tenantId_slug: { tenantId: tenant.id, slug: cfg.locationSlug } },
    create: {
      tenantId: tenant.id,
      slug: cfg.locationSlug,
      name: cfg.locationName,
      timezone: cfg.timezone,
      storeHours: HOURS.storeHours,
      departmentHours: HOURS.departmentHours,
      storeHoursVerifiedAt: new Date(),
      storeHoursVerifiedBy: 'synthetic-demo (not real store hours)',
    },
    update: {
      name: cfg.locationName,
      timezone: cfg.timezone,
      storeHours: HOURS.storeHours,
      departmentHours: HOURS.departmentHours,
      storeHoursVerifiedAt: new Date(),
      storeHoursVerifiedBy: 'synthetic-demo (not real store hours)',
    },
  });

  const now = new Date();
  for (const v of VEHICLES) {
    const data = {
      tenantId: tenant.id,
      locationId: location.id,
      vin: v.vin,
      stock: v.stock,
      year: v.year,
      make: v.make,
      model: v.model,
      trim: v.trim,
      bodyType: v.bodyType,
      drivetrain: v.drivetrain,
      transmission: '8-speed automatic',
      fuelType: v.fuelType,
      color: v.color,
      interiorColor: v.interiorColor ?? null,
      price: v.price,
      msrp: v.msrp ?? null,
      mileage: v.mileage,
      condition: v.condition,
      features: v.features,
      photos: [],
      status: v.status ?? 'AVAILABLE',
      source: 'synthetic_demo',
      lastSeenAt: now,
      sourceTimestamp: now,
      freshnessState: 'FRESH' as const,
      rawSource: { note: 'SIMULATED demo fixture — not dealership inventory' },
    };
    await prisma.vehicle.upsert({
      where: { tenantId_vin: { tenantId: tenant.id, vin: v.vin } },
      create: data,
      update: data,
    });
  }

  const email = process.env.DEMO_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.DEMO_ADMIN_PASSWORD;
  let staff =
    'skipped (set DEMO_ADMIN_EMAIL and DEMO_ADMIN_PASSWORD to create one)';
  if (email && password) {
    if (password.length < 12) {
      console.error('DEMO_ADMIN_PASSWORD must be at least 12 characters.');
      process.exit(1);
    }
    const hash = await bcrypt.hash(password, 12);
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
      update: { password: hash, isActive: true, role: Role.ADMIN },
    });
    staff = `ADMIN ${email} (password from your shell; not stored anywhere else)`;
  }

  console.log(
    JSON.stringify(
      {
        tenantSlug: tenant.slug,
        locationSlug: location.slug,
        locationId: location.id,
        vehicles: VEHICLES.length,
        inventory: 'SIMULATED (source=synthetic_demo)',
        hours: 'synthetic demo hours (labeled to customers)',
        appointments: 'REQUEST records enabled',
        creditApplication:
          'not configured by seed — see npm run credit:destination',
        staff,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
