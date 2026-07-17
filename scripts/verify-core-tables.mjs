#!/usr/bin/env node
/**
 * Verifies the tenant-isolation core tables exist after `prisma migrate
 * deploy` on an empty database (used by CI's migrations-empty-db job).
 *
 * Cast regclass → text so Prisma can deserialize the column.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
try {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT to_regclass('public."Tenant"')::text      AS tenant,
            to_regclass('public."Location"')::text    AS location,
            to_regclass('public."User"')::text        AS "user",
            to_regclass('public."Lead"')::text        AS lead,
            to_regclass('public."OutboxEvent"')::text AS outbox`,
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
