/**
 * Safe CLI onboarding (idempotent). Uses DATABASE_URL from env.
 *
 * Usage:
 *   npx ts-node --transpile-only scripts/onboard-dealership.ts --config path/to.json
 *
 * Config JSON matches OnboardDealershipDto fields.
 */
import { PrismaClient, Prisma } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import * as bcrypt from 'bcryptjs';

type Config = {
  dealerGroupName?: string;
  dealerGroupSlug?: string;
  tenantName: string;
  tenantSlug: string;
  locationName: string;
  locationSlug: string;
  allowedOrigins?: string[];
  timezone?: string;
  address?: string;
  phone?: string;
  storeHours?: Record<string, unknown>;
  branding?: Record<string, unknown>;
  featureFlags?: Record<string, boolean>;
  inventoryFeedUrl?: string;
  inventoryFeedType?: 'XML' | 'JSON' | 'CSV';
  escalationRecipients?: string[];
  dataRetentionDays?: number;
  consentText?: string;
  adminUser?: {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
  };
};

async function main() {
  const idx = process.argv.indexOf('--config');
  if (idx < 0 || !process.argv[idx + 1]) {
    console.error('Usage: --config path/to.json');
    process.exit(1);
  }
  const configPath = path.resolve(process.argv[idx + 1]);
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Config;
  const prisma = new PrismaClient();

  try {
    let dealerGroupId: string | undefined;
    if (cfg.dealerGroupSlug && cfg.dealerGroupName) {
      const g = await prisma.dealerGroup.upsert({
        where: { slug: cfg.dealerGroupSlug },
        create: { slug: cfg.dealerGroupSlug, name: cfg.dealerGroupName },
        update: { name: cfg.dealerGroupName },
      });
      dealerGroupId = g.id;
    }

    const tenant = await prisma.tenant.upsert({
      where: { slug: cfg.tenantSlug },
      create: {
        slug: cfg.tenantSlug,
        name: cfg.tenantName,
        dealerGroupId,
        allowedOrigins: cfg.allowedOrigins?.join(',') ?? null,
        publicConfig: (cfg.branding ?? {}) as Prisma.InputJsonValue,
        featureFlags: (cfg.featureFlags ?? {}) as Prisma.InputJsonValue,
        dataRetentionDays: cfg.dataRetentionDays ?? 365,
        consentText: cfg.consentText ?? null,
      },
      update: {
        name: cfg.tenantName,
        dealerGroupId,
        allowedOrigins: cfg.allowedOrigins?.join(',') ?? undefined,
        publicConfig: cfg.branding as Prisma.InputJsonValue | undefined,
        featureFlags: cfg.featureFlags as Prisma.InputJsonValue | undefined,
        dataRetentionDays: cfg.dataRetentionDays,
        consentText: cfg.consentText,
        configVersion: { increment: 1 },
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
        timezone: cfg.timezone ?? 'America/Chicago',
        address: cfg.address,
        phone: cfg.phone,
        storeHours: cfg.storeHours as Prisma.InputJsonValue | undefined,
        publicConfig: (cfg.branding ?? {}) as Prisma.InputJsonValue,
        inventoryFeedUrl: cfg.inventoryFeedUrl,
        inventoryFeedType: cfg.inventoryFeedType as never,
        escalationRecipients: cfg.escalationRecipients?.join(',') ?? null,
      },
      update: {
        name: cfg.locationName,
        timezone: cfg.timezone,
        address: cfg.address,
        phone: cfg.phone,
        storeHours: cfg.storeHours as Prisma.InputJsonValue | undefined,
        publicConfig: cfg.branding as Prisma.InputJsonValue | undefined,
        inventoryFeedUrl: cfg.inventoryFeedUrl,
        inventoryFeedType: cfg.inventoryFeedType as never,
        escalationRecipients: cfg.escalationRecipients?.join(','),
      },
    });

    if (cfg.adminUser) {
      const hash = await bcrypt.hash(cfg.adminUser.password, 12);
      await prisma.user.upsert({
        where: {
          tenantId_email: {
            tenantId: tenant.id,
            email: cfg.adminUser.email.toLowerCase(),
          },
        },
        create: {
          tenantId: tenant.id,
          locationId: location.id,
          email: cfg.adminUser.email.toLowerCase(),
          password: hash,
          firstName: cfg.adminUser.firstName,
          lastName: cfg.adminUser.lastName,
          role: 'ADMIN',
        },
        update: {
          firstName: cfg.adminUser.firstName,
          lastName: cfg.adminUser.lastName,
        },
      });
    }

    await prisma.auditLog.create({
      data: {
        tenantId: tenant.id,
        action: 'onboarding.cli',
        resource: 'Tenant',
        resourceId: tenant.id,
        metadata: { tenantSlug: tenant.slug, locationSlug: location.slug },
      },
    });

    console.log(
      JSON.stringify(
        {
          ok: true,
          dealerGroupId: dealerGroupId ?? null,
          tenantId: tenant.id,
          tenantSlug: tenant.slug,
          locationId: location.id,
          locationSlug: location.slug,
          configVersion: tenant.configVersion,
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
