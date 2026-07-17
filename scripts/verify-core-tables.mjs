#!/usr/bin/env node
/**
 * Verifies the tenant-isolation core tables exist after `prisma migrate
 * deploy` on an empty database (used by CI's migrations-empty-db job).
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
try {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT to_regclass('public."Tenant"')      AS tenant,
            to_regclass('public."Location"')    AS location,
            to_regclass('public."User"')        AS "user",
            to_regclass('public."Lead"')        AS lead,
            to_regclass('public."OutboxEvent"') AS outbox`,
  );
  const r = rows[0];
  const missing = Object.entries(r)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    console.error('missing core tables:', missing.join(', '));
    process.exit(1);
  }
  console.log('empty-db migration verification passed:', r);
} finally {
  await prisma.$disconnect();
}
