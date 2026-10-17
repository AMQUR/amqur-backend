-- Additive: tokenized customer action pages (no destructive changes).

CREATE TABLE IF NOT EXISTS "CustomerActionPage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT,
    "leadId" TEXT,
    "conversationId" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "formSchema" JSONB,
    "staffMeta" JSONB,
    "tokenHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "expiresAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerActionPage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CustomerActionPage_tokenHash_key" ON "CustomerActionPage"("tokenHash");
CREATE INDEX IF NOT EXISTS "CustomerActionPage_tenantId_status_idx" ON "CustomerActionPage"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "CustomerActionPage_tenantId_leadId_idx" ON "CustomerActionPage"("tenantId", "leadId");

DO $$ BEGIN
  ALTER TABLE "CustomerActionPage"
    ADD CONSTRAINT "CustomerActionPage_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
