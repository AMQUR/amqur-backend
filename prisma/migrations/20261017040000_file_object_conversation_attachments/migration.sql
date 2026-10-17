-- Additive: tenant-scoped file registry + conversation attachment index.
-- conversationId is nullable; staff link CLEAN files via ops API.

DO $$ BEGIN
  CREATE TYPE "FilePurpose" AS ENUM (
    'TRADE_PHOTO',
    'SERVICE_PHOTO',
    'DOCUMENT',
    'KNOWLEDGE_UPLOAD',
    'OTHER'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "FileScanStatus" AS ENUM (
    'PENDING',
    'CLEAN',
    'REJECTED',
    'SKIPPED',
    'ERROR'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "FileObject" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT,
    "storageKey" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "checksumSha256" TEXT NOT NULL,
    "purpose" "FilePurpose" NOT NULL,
    "scannedStatus" "FileScanStatus" NOT NULL DEFAULT 'PENDING',
    "uploadedByUserId" TEXT,
    "conversationId" TEXT,
    "metadata" JSONB,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FileObject_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "FileObject" ADD COLUMN IF NOT EXISTS "conversationId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "FileObject_tenantId_storageKey_key"
  ON "FileObject"("tenantId", "storageKey");

CREATE INDEX IF NOT EXISTS "FileObject_tenantId_purpose_idx"
  ON "FileObject"("tenantId", "purpose");

CREATE INDEX IF NOT EXISTS "FileObject_tenantId_conversationId_idx"
  ON "FileObject"("tenantId", "conversationId");

DO $$ BEGIN
  ALTER TABLE "FileObject"
    ADD CONSTRAINT "FileObject_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "FileObject"
    ADD CONSTRAINT "FileObject_locationId_fkey"
    FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
