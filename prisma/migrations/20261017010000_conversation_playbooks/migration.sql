-- Additive: Conversation Studio playbooks, prompt versions, location messaging policy.
-- No destructive changes. Defaults keep existing behavior (concise replies, quiet 21:00–08:00).

-- AlterTable
ALTER TABLE "Location" ADD COLUMN IF NOT EXISTS "messagingPolicy" JSONB;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "PlaybookStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'PUBLISHED', 'ARCHIVED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "PlaybookDepartment" AS ENUM ('GENERAL', 'SALES', 'SERVICE', 'PARTS', 'FINANCE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "ConversationPlaybook" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT,
    "locationScope" TEXT NOT NULL DEFAULT '_',
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "department" "PlaybookDepartment" NOT NULL DEFAULT 'GENERAL',
    "status" "PlaybookStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "tone" TEXT NOT NULL DEFAULT 'concise',
    "brevity" TEXT NOT NULL DEFAULT 'short',
    "allowRapport" BOOLEAN NOT NULL DEFAULT false,
    "oneQuestion" BOOLEAN NOT NULL DEFAULT true,
    "approvedPhrases" JSONB,
    "forbiddenPhrases" JSONB,
    "examples" JSONB,
    "coachingNotes" TEXT,
    "supersedesId" TEXT,
    "publishedAt" TIMESTAMP(3),
    "publishedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationPlaybook_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PromptVersion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT,
    "locationScope" TEXT NOT NULL DEFAULT '_',
    "kind" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "status" "PlaybookStatus" NOT NULL DEFAULT 'DRAFT',
    "content" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "notes" TEXT,
    "publishedAt" TIMESTAMP(3),
    "publishedBy" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ConversationPlaybook_tenantId_locationScope_key_version_key"
  ON "ConversationPlaybook"("tenantId", "locationScope", "key", "version");
CREATE INDEX IF NOT EXISTS "ConversationPlaybook_tenantId_status_idx"
  ON "ConversationPlaybook"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "ConversationPlaybook_tenantId_locationId_department_status_idx"
  ON "ConversationPlaybook"("tenantId", "locationId", "department", "status");

CREATE UNIQUE INDEX IF NOT EXISTS "PromptVersion_tenantId_locationScope_kind_version_key"
  ON "PromptVersion"("tenantId", "locationScope", "kind", "version");
CREATE INDEX IF NOT EXISTS "PromptVersion_tenantId_kind_status_idx"
  ON "PromptVersion"("tenantId", "kind", "status");

ALTER TABLE "ConversationPlaybook"
  DROP CONSTRAINT IF EXISTS "ConversationPlaybook_tenantId_fkey";
ALTER TABLE "ConversationPlaybook"
  ADD CONSTRAINT "ConversationPlaybook_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ConversationPlaybook"
  DROP CONSTRAINT IF EXISTS "ConversationPlaybook_locationId_fkey";
ALTER TABLE "ConversationPlaybook"
  ADD CONSTRAINT "ConversationPlaybook_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PromptVersion"
  DROP CONSTRAINT IF EXISTS "PromptVersion_tenantId_fkey";
ALTER TABLE "PromptVersion"
  ADD CONSTRAINT "PromptVersion_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PromptVersion"
  DROP CONSTRAINT IF EXISTS "PromptVersion_locationId_fkey";
ALTER TABLE "PromptVersion"
  ADD CONSTRAINT "PromptVersion_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
