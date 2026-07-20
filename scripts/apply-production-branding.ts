/**
 * Upsert production publicConfig branding fields for Dial Auto Group tenants.
 *
 * Merges only: logoUrl, primaryColor, accentColor, logoAlt.
 * Increments tenant.configVersion.
 * Does NOT modify allowedOrigins (or any other tenant columns).
 *
 * Usage (production):
 *   railway ssh -s prod-api
 *   # then inside the service shell, with DATABASE_URL available:
 *   npx ts-node --transpile-only scripts/apply-production-branding.ts
 *
 * Or via Railway run when the service image includes this script:
 *   railway run -s prod-api -- npx ts-node --transpile-only scripts/apply-production-branding.ts
 *
 * Dry-run (no writes):
 *   npx ts-node --transpile-only scripts/apply-production-branding.ts --dry-run
 *
 * Requires DATABASE_URL. Do not enable public traffic or add website origins here.
 */
import { PrismaClient, Prisma } from '@prisma/client';

const PRIMARY = '#E5042F';
const ACCENT = '#FFFFFF';

type BrandingPatch = {
  logoUrl: string;
  primaryColor: string;
  accentColor: string;
  logoAlt: string;
};

const TENANTS: Array<{ slug: string; branding: BrandingPatch }> = [
  {
    slug: 'dial-auto-group',
    branding: {
      logoUrl:
        'https://widget.dialusnow.com/assets/tenants/dial-auto-group/logo.14cd52b7b4aa.svg',
      primaryColor: PRIMARY,
      accentColor: ACCENT,
      logoAlt: 'Dial Auto Group logo',
    },
  },
  {
    slug: 'dial-chevy-of-chicago',
    branding: {
      logoUrl:
        'https://widget.dialusnow.com/assets/tenants/dial-chevy-of-chicago/logo.f01bc53bc899.svg',
      primaryColor: PRIMARY,
      accentColor: ACCENT,
      logoAlt: 'Dial Chevy of Chicago logo',
    },
  },
  {
    slug: 'dial-cdjr-of-chicago',
    branding: {
      logoUrl:
        'https://widget.dialusnow.com/assets/tenants/dial-cdjr-of-chicago/logo.7120c2356ee4.svg',
      primaryColor: PRIMARY,
      accentColor: ACCENT,
      logoAlt: 'Dial CDJR of Chicago logo',
    },
  },
  {
    slug: 'infiniti-of-chicago',
    branding: {
      logoUrl:
        'https://widget.dialusnow.com/assets/tenants/infiniti-of-chicago/logo.3e97eead086a.svg',
      primaryColor: PRIMARY,
      accentColor: ACCENT,
      logoAlt: 'INFINITI of Chicago logo',
    },
  },
  {
    slug: 'jeep-of-chicago',
    branding: {
      logoUrl:
        'https://widget.dialusnow.com/assets/tenants/jeep-of-chicago/logo.65f09faa2c92.svg',
      primaryColor: PRIMARY,
      accentColor: ACCENT,
      logoAlt: 'Jeep of Chicago logo',
    },
  },
  {
    slug: 'dial-nissan-of-chicago',
    branding: {
      logoUrl:
        'https://widget.dialusnow.com/assets/tenants/dial-nissan-of-chicago/logo.fd272741fd3c.svg',
      primaryColor: PRIMARY,
      accentColor: ACCENT,
      logoAlt: 'Dial Nissan of Chicago logo',
    },
  },
];

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? { ...(v as Record<string, unknown>) }
    : {};
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    for (const { slug, branding } of TENANTS) {
      const tenant = await prisma.tenant.findUnique({ where: { slug } });
      if (!tenant) {
        console.error(`[skip] tenant not found: ${slug}`);
        continue;
      }

      const merged = {
        ...asRecord(tenant.publicConfig),
        logoUrl: branding.logoUrl,
        primaryColor: branding.primaryColor,
        accentColor: branding.accentColor,
        logoAlt: branding.logoAlt,
      };

      console.log(
        `${dryRun ? '[dry-run] ' : ''}upsert ${slug} configVersion ${tenant.configVersion} → ${tenant.configVersion + 1}`,
      );
      console.log(`  logoUrl=${branding.logoUrl}`);
      console.log(`  primaryColor=${branding.primaryColor} accentColor=${branding.accentColor}`);

      if (dryRun) continue;

      await prisma.tenant.update({
        where: { slug },
        data: {
          publicConfig: merged as Prisma.InputJsonValue,
          configVersion: { increment: 1 },
          // intentionally omit allowedOrigins
        },
      });
    }
    console.log(dryRun ? 'Dry-run complete.' : 'Branding apply complete.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
