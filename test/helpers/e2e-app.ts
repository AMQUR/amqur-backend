import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { GlobalExceptionFilter } from '../../src/common/filters/global-exception.filter';
import { ResponseInterceptor } from '../../src/common/interceptors/response.interceptor';
import { RequestIdInterceptor } from '../../src/common/interceptors/request-id.interceptor';
import { PrismaService } from '../../src/prisma/prisma.service';
import * as bcrypt from 'bcryptjs';
import { InventoryFreshnessState, Role, VehicleStatus } from '@prisma/client';

export type E2eCtx = {
  app: INestApplication<App>;
  prisma: PrismaService;
};

export async function createE2eApp(): Promise<E2eCtx> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalInterceptors(
    new RequestIdInterceptor(),
    new ResponseInterceptor(),
  );
  await app.init();
  const prisma = app.get(PrismaService);
  return { app, prisma };
}

export function unwrap<T>(body: unknown): T {
  if (body && typeof body === 'object' && 'data' in (body as object)) {
    return (body as { data: T }).data;
  }
  return body as T;
}

/** Seed two fully isolated tenants for attack / e2e suites. */
export async function seedTwoTenants(prisma: PrismaService) {
  const password = await bcrypt.hash('TestPass123!', 10);

  const alpha = await prisma.tenant.upsert({
    where: { slug: 'pilot-alpha' },
    create: {
      slug: 'pilot-alpha',
      name: 'Pilot Alpha Motors',
      allowedOrigins: 'http://127.0.0.1:18084,http://localhost:18084',
      featureFlags: {
        chat: true,
        inventory: true,
        payments: false,
        financeCalculator: false,
        handoff: true,
        leadCapture: true,
        vehicleCompare: true,
        savedVehicles: true,
        serviceAi: false,
        partsAi: false,
      },
      publicConfig: {
        assistantDisplayName: 'Alpha Assistant',
        primaryColor: '#111111',
        welcomeMessage: 'Hello from Alpha',
        disclaimerText: 'Verified records only.',
      },
      consentText: 'Alpha consent',
    },
    update: {
      allowedOrigins: 'http://127.0.0.1:18084,http://localhost:18084',
      featureFlags: {
        chat: true,
        inventory: true,
        payments: false,
        financeCalculator: false,
        handoff: true,
        leadCapture: true,
        vehicleCompare: true,
        savedVehicles: true,
        serviceAi: false,
        partsAi: false,
      },
      configVersion: { increment: 1 },
    },
  });

  const beta = await prisma.tenant.upsert({
    where: { slug: 'pilot-beta' },
    create: {
      slug: 'pilot-beta',
      name: 'Pilot Beta Motors',
      allowedOrigins: 'http://127.0.0.1:18084',
      featureFlags: {
        chat: true,
        inventory: false,
        payments: false,
        handoff: true,
        leadCapture: true,
      },
      publicConfig: {
        assistantDisplayName: 'Beta Assistant',
        primaryColor: '#222222',
        welcomeMessage: 'Hello from Beta',
      },
    },
    update: {
      featureFlags: {
        chat: true,
        inventory: false,
        payments: false,
        handoff: true,
        leadCapture: true,
      },
      configVersion: { increment: 1 },
    },
  });

  const alphaLoc = await prisma.location.upsert({
    where: { tenantId_slug: { tenantId: alpha.id, slug: 'main' } },
    create: {
      tenantId: alpha.id,
      slug: 'main',
      name: 'Alpha Main',
      phone: '555-0101',
      timezone: 'America/Chicago',
      inventoryFeedUrl: 'http://127.0.0.1:18082/feed.json',
      inventoryFeedType: 'JSON',
    },
    update: {
      inventoryFeedUrl: 'http://127.0.0.1:18082/feed.json',
      inventoryFeedType: 'JSON',
    },
  });

  const betaLoc = await prisma.location.upsert({
    where: { tenantId_slug: { tenantId: beta.id, slug: 'main' } },
    create: {
      tenantId: beta.id,
      slug: 'main',
      name: 'Beta Main',
      phone: '555-0202',
      timezone: 'America/Chicago',
    },
    update: {},
  });

  const alphaAdmin = await prisma.user.upsert({
    where: {
      tenantId_email: { tenantId: alpha.id, email: 'admin@pilot-alpha.test' },
    },
    create: {
      tenantId: alpha.id,
      locationId: alphaLoc.id,
      email: 'admin@pilot-alpha.test',
      password,
      firstName: 'Alpha',
      lastName: 'Admin',
      role: Role.ADMIN,
    },
    update: { password },
  });

  const betaAdmin = await prisma.user.upsert({
    where: {
      tenantId_email: { tenantId: beta.id, email: 'admin@pilot-beta.test' },
    },
    create: {
      tenantId: beta.id,
      locationId: betaLoc.id,
      email: 'admin@pilot-beta.test',
      password,
      firstName: 'Beta',
      lastName: 'Admin',
      role: Role.ADMIN,
    },
    update: { password },
  });

  const superAdminTenant = alpha;
  const superAdmin = await prisma.user.upsert({
    where: {
      tenantId_email: {
        tenantId: superAdminTenant.id,
        email: 'super@amqur-test.local',
      },
    },
    create: {
      tenantId: superAdminTenant.id,
      email: 'super@amqur-test.local',
      password,
      firstName: 'Super',
      lastName: 'Admin',
      role: Role.SUPER_ADMIN,
    },
    update: { password, role: Role.SUPER_ADMIN },
  });

  // Fresh inventory for alpha only (test VINs — not production)
  await prisma.vehicle.upsert({
    where: {
      tenantId_vin: { tenantId: alpha.id, vin: '1C4RJFBG0MC100001' },
    },
    create: {
      tenantId: alpha.id,
      locationId: alphaLoc.id,
      vin: '1C4RJFBG0MC100001',
      stock: 'TEST1001',
      year: 2024,
      make: 'Jeep',
      model: 'Grand Cherokee',
      trim: 'Limited',
      price: 45990,
      msrp: 48990,
      mileage: 12,
      status: VehicleStatus.AVAILABLE,
      source: 'test_fixture',
      lastSeenAt: new Date(),
      freshnessState: InventoryFreshnessState.FRESH,
    },
    update: {
      status: VehicleStatus.AVAILABLE,
      freshnessState: InventoryFreshnessState.FRESH,
      lastSeenAt: new Date(),
      price: 45990,
    },
  });

  // Stale vehicle for freshness tests
  await prisma.vehicle.upsert({
    where: {
      tenantId_vin: { tenantId: alpha.id, vin: '1C4RJFBG0MC100099' },
    },
    create: {
      tenantId: alpha.id,
      locationId: alphaLoc.id,
      vin: '1C4RJFBG0MC100099',
      stock: 'STALE99',
      year: 2020,
      make: 'Jeep',
      model: 'Cherokee',
      price: 19990,
      status: VehicleStatus.AVAILABLE,
      source: 'test_fixture',
      lastSeenAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
      freshnessState: InventoryFreshnessState.STALE,
    },
    update: {
      freshnessState: InventoryFreshnessState.STALE,
      lastSeenAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
    },
  });

  // Beta secret vehicle — must never leak to alpha
  await prisma.vehicle.upsert({
    where: {
      tenantId_vin: { tenantId: beta.id, vin: '1C4RJFBG0MC200001' },
    },
    create: {
      tenantId: beta.id,
      locationId: betaLoc.id,
      vin: '1C4RJFBG0MC200001',
      stock: 'BETA001',
      year: 2024,
      make: 'Nissan',
      model: 'Rogue',
      price: 32990,
      status: VehicleStatus.AVAILABLE,
      source: 'test_fixture',
      lastSeenAt: new Date(),
      freshnessState: InventoryFreshnessState.FRESH,
    },
    update: {
      freshnessState: InventoryFreshnessState.FRESH,
      lastSeenAt: new Date(),
    },
  });

  const alphaLead = await prisma.lead.create({
    data: {
      tenantId: alpha.id,
      locationId: alphaLoc.id,
      email: 'alpha-customer@example.test',
      phone: '555-1000',
      firstName: 'Alpha',
      lastName: 'Customer',
      interestedVin: '1C4RJFBG0MC100001',
      source: 'e2e',
    },
  });

  const betaLead = await prisma.lead.create({
    data: {
      tenantId: beta.id,
      locationId: betaLoc.id,
      email: 'beta-customer@example.test',
      phone: '555-2000',
      firstName: 'Beta',
      lastName: 'Customer',
      interestedVin: '1C4RJFBG0MC200001',
      source: 'e2e',
    },
  });

  return {
    alpha: {
      tenant: alpha,
      location: alphaLoc,
      admin: alphaAdmin,
      lead: alphaLead,
      password: 'TestPass123!',
    },
    beta: {
      tenant: beta,
      location: betaLoc,
      admin: betaAdmin,
      lead: betaLead,
      password: 'TestPass123!',
    },
    superAdmin: { user: superAdmin, password: 'TestPass123!' },
  };
}
