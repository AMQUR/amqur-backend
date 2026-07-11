-- CreateEnum
CREATE TYPE "InventoryFreshnessState" AS ENUM ('FRESH', 'DEGRADED', 'STALE', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "CrmSyncStatus" AS ENUM ('NONE', 'PENDING', 'SYNCED', 'CONFLICT', 'FAILED');

-- CreateEnum
CREATE TYPE "IntegrationProvider" AS ENUM ('TEKION', 'VAUTO', 'TWILIO', 'GOOGLE_CALENDAR', 'GENERIC_WEBHOOK', 'MOCK');

-- CreateEnum
CREATE TYPE "IntegrationHealthStatus" AS ENUM ('UNKNOWN', 'HEALTHY', 'DEGRADED', 'UNHEALTHY', 'DISABLED');

-- CreateEnum
CREATE TYPE "SourceConflictStatus" AS ENUM ('OPEN', 'RESOLVED', 'IGNORED');

-- CreateEnum
CREATE TYPE "InventoryImportStatus" AS ENUM ('PENDING', 'DOWNLOADED', 'VALIDATING', 'STAGED', 'RECONCILING', 'SUCCEEDED', 'FAILED', 'REJECTED_ANOMALY');

-- CreateEnum
CREATE TYPE "PartsInquiryStatus" AS ENUM ('REQUESTED', 'PENDING_STAFF', 'FITMENT_PENDING', 'QUOTED', 'ORDERED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED', 'DEAD');

-- CreateEnum
CREATE TYPE "WebhookInboxStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED', 'DUPLICATE', 'REJECTED');

-- AlterEnum
ALTER TYPE "ConversationChannel" ADD VALUE IF NOT EXISTS 'WHATSAPP';
ALTER TYPE "ConversationChannel" ADD VALUE IF NOT EXISTS 'MESSENGER';
ALTER TYPE "ConversationChannel" ADD VALUE IF NOT EXISTS 'INSTAGRAM';
ALTER TYPE "ConversationChannel" ADD VALUE IF NOT EXISTS 'VOICE';
ALTER TYPE "ConversationChannel" ADD VALUE IF NOT EXISTS 'GOOGLE_BUSINESS';

-- AlterTable Tenant
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "featureFlags" JSONB;

-- AlterTable Location
ALTER TABLE "Location" ADD COLUMN IF NOT EXISTS "externalIds" JSONB;
ALTER TABLE "Location" ADD COLUMN IF NOT EXISTS "featureFlags" JSONB;
ALTER TABLE "Location" ADD COLUMN IF NOT EXISTS "inventoryFreshnessHours" INTEGER NOT NULL DEFAULT 24;
ALTER TABLE "Location" ADD COLUMN IF NOT EXISTS "inventoryMinRecords" INTEGER NOT NULL DEFAULT 1;

-- AlterTable Vehicle
ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "condition" TEXT;
ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "freshnessState" "InventoryFreshnessState" NOT NULL DEFAULT 'UNAVAILABLE';
ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "importRunId" TEXT;
ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "sourceTimestamp" TIMESTAMP(3);
ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "rawSource" JSONB;
CREATE INDEX IF NOT EXISTS "Vehicle_tenantId_freshnessState_idx" ON "Vehicle"("tenantId", "freshnessState");

-- AlterTable Lead
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "languagePreference" TEXT;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "purchaseTimeline" TEXT;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "tradeInInterest" BOOLEAN;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "leaseVsPurchase" TEXT;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "consentToCall" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "optOutAt" TIMESTAMP(3);
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "scoreReasons" JSONB;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "scoreVersion" TEXT;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "utmSource" TEXT;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "utmMedium" TEXT;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "utmCampaign" TEXT;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "externalCrmCustomerId" TEXT;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "externalCrmLeadId" TEXT;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "crmSyncStatus" "CrmSyncStatus" NOT NULL DEFAULT 'NONE';
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "crmLastSyncedAt" TIMESTAMP(3);
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "crmLastError" TEXT;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "nextBestAction" TEXT;
CREATE INDEX IF NOT EXISTS "Lead_tenantId_externalCrmLeadId_idx" ON "Lead"("tenantId", "externalCrmLeadId");

-- CreateTable IntegrationConnection
CREATE TABLE IF NOT EXISTS "IntegrationConnection" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT,
    "provider" "IntegrationProvider" NOT NULL,
    "capability" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "liveReady" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL DEFAULT '{}',
    "healthStatus" "IntegrationHealthStatus" NOT NULL DEFAULT 'UNKNOWN',
    "lastHealthAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastError" TEXT,
    "circuitOpenUntil" TIMESTAMP(3),
    "syncCursor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationConnection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "IntegrationConnection_tenantId_locationId_provider_capability_key"
  ON "IntegrationConnection"("tenantId", "locationId", "provider", "capability");
CREATE INDEX IF NOT EXISTS "IntegrationConnection_tenantId_provider_idx" ON "IntegrationConnection"("tenantId", "provider");
CREATE INDEX IF NOT EXISTS "IntegrationConnection_tenantId_enabled_idx" ON "IntegrationConnection"("tenantId", "enabled");

ALTER TABLE "IntegrationConnection"
  DROP CONSTRAINT IF EXISTS "IntegrationConnection_tenantId_fkey";
ALTER TABLE "IntegrationConnection"
  ADD CONSTRAINT "IntegrationConnection_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntegrationConnection"
  DROP CONSTRAINT IF EXISTS "IntegrationConnection_locationId_fkey";
ALTER TABLE "IntegrationConnection"
  ADD CONSTRAINT "IntegrationConnection_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "IntegrationSecret" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "keyName" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationSecret_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "IntegrationSecret_connectionId_keyName_key"
  ON "IntegrationSecret"("connectionId", "keyName");
ALTER TABLE "IntegrationSecret"
  DROP CONSTRAINT IF EXISTS "IntegrationSecret_connectionId_fkey";
ALTER TABLE "IntegrationSecret"
  ADD CONSTRAINT "IntegrationSecret_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "SourceAuthorityRule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "primarySource" TEXT NOT NULL,
    "fallbackSource" TEXT,
    "freshnessSlaHours" INTEGER NOT NULL DEFAULT 24,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourceAuthorityRule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SourceAuthorityRule_tenantId_field_key" ON "SourceAuthorityRule"("tenantId", "field");
CREATE INDEX IF NOT EXISTS "SourceAuthorityRule_tenantId_idx" ON "SourceAuthorityRule"("tenantId");
ALTER TABLE "SourceAuthorityRule"
  DROP CONSTRAINT IF EXISTS "SourceAuthorityRule_tenantId_fkey";
ALTER TABLE "SourceAuthorityRule"
  ADD CONSTRAINT "SourceAuthorityRule_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "SourceConflict" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "primaryValue" TEXT,
    "conflictingValue" TEXT,
    "primarySource" TEXT NOT NULL,
    "conflictingSource" TEXT NOT NULL,
    "status" "SourceConflictStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourceConflict_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SourceConflict_tenantId_status_idx" ON "SourceConflict"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "SourceConflict_tenantId_entityType_entityId_idx"
  ON "SourceConflict"("tenantId", "entityType", "entityId");
ALTER TABLE "SourceConflict"
  DROP CONSTRAINT IF EXISTS "SourceConflict_tenantId_fkey";
ALTER TABLE "SourceConflict"
  ADD CONSTRAINT "SourceConflict_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "InventoryImportRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT,
    "provider" "IntegrationProvider" NOT NULL DEFAULT 'VAUTO',
    "transport" TEXT,
    "format" TEXT,
    "status" "InventoryImportStatus" NOT NULL DEFAULT 'PENDING',
    "sourceIdentifier" TEXT,
    "checksum" TEXT,
    "recordCount" INTEGER,
    "validCount" INTEGER,
    "rejectedCount" INTEGER,
    "anomalyFlags" JSONB,
    "rawArtifactPath" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "InventoryImportRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "InventoryImportRun_tenantId_startedAt_idx" ON "InventoryImportRun"("tenantId", "startedAt");
CREATE INDEX IF NOT EXISTS "InventoryImportRun_locationId_startedAt_idx" ON "InventoryImportRun"("locationId", "startedAt");
CREATE INDEX IF NOT EXISTS "InventoryImportRun_status_idx" ON "InventoryImportRun"("status");
ALTER TABLE "InventoryImportRun"
  DROP CONSTRAINT IF EXISTS "InventoryImportRun_tenantId_fkey";
ALTER TABLE "InventoryImportRun"
  ADD CONSTRAINT "InventoryImportRun_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InventoryImportRun"
  DROP CONSTRAINT IF EXISTS "InventoryImportRun_locationId_fkey";
ALTER TABLE "InventoryImportRun"
  ADD CONSTRAINT "InventoryImportRun_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "SavedVehicle" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT,
    "conversationExternalKey" TEXT NOT NULL,
    "vin" TEXT NOT NULL,
    "alertPriceDrop" BOOLEAN NOT NULL DEFAULT false,
    "alertBackInStock" BOOLEAN NOT NULL DEFAULT false,
    "consentOutbound" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedVehicle_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SavedVehicle_tenantId_conversationExternalKey_vin_key"
  ON "SavedVehicle"("tenantId", "conversationExternalKey", "vin");
CREATE INDEX IF NOT EXISTS "SavedVehicle_tenantId_vin_idx" ON "SavedVehicle"("tenantId", "vin");
ALTER TABLE "SavedVehicle"
  DROP CONSTRAINT IF EXISTS "SavedVehicle_tenantId_fkey";
ALTER TABLE "SavedVehicle"
  ADD CONSTRAINT "SavedVehicle_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SavedVehicle"
  DROP CONSTRAINT IF EXISTS "SavedVehicle_locationId_fkey";
ALTER TABLE "SavedVehicle"
  ADD CONSTRAINT "SavedVehicle_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "PartsInquiry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT,
    "conversationId" TEXT,
    "vin" TEXT,
    "partDescription" TEXT NOT NULL,
    "status" "PartsInquiryStatus" NOT NULL DEFAULT 'REQUESTED',
    "fitmentVerified" BOOLEAN NOT NULL DEFAULT false,
    "availabilityVerified" BOOLEAN NOT NULL DEFAULT false,
    "priceVerified" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "customerName" TEXT,
    "customerPhone" TEXT,
    "customerEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartsInquiry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PartsInquiry_tenantId_status_idx" ON "PartsInquiry"("tenantId", "status");
ALTER TABLE "PartsInquiry"
  DROP CONSTRAINT IF EXISTS "PartsInquiry_tenantId_fkey";
ALTER TABLE "PartsInquiry"
  ADD CONSTRAINT "PartsInquiry_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PartsInquiry"
  DROP CONSTRAINT IF EXISTS "PartsInquiry_locationId_fkey";
ALTER TABLE "PartsInquiry"
  ADD CONSTRAINT "PartsInquiry_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "OutboxEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "idempotencyKey" TEXT,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "OutboxEvent_tenantId_idempotencyKey_key" ON "OutboxEvent"("tenantId", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "OutboxEvent_status_nextAttemptAt_idx" ON "OutboxEvent"("status", "nextAttemptAt");
CREATE INDEX IF NOT EXISTS "OutboxEvent_tenantId_topic_idx" ON "OutboxEvent"("tenantId", "topic");
ALTER TABLE "OutboxEvent"
  DROP CONSTRAINT IF EXISTS "OutboxEvent_tenantId_fkey";
ALTER TABLE "OutboxEvent"
  ADD CONSTRAINT "OutboxEvent_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "WebhookInbox" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "signatureValid" BOOLEAN NOT NULL DEFAULT false,
    "payload" JSONB NOT NULL,
    "status" "WebhookInboxStatus" NOT NULL DEFAULT 'RECEIVED',
    "processedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookInbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "WebhookInbox_tenantId_provider_externalEventId_key"
  ON "WebhookInbox"("tenantId", "provider", "externalEventId");
CREATE INDEX IF NOT EXISTS "WebhookInbox_status_createdAt_idx" ON "WebhookInbox"("status", "createdAt");
ALTER TABLE "WebhookInbox"
  DROP CONSTRAINT IF EXISTS "WebhookInbox_tenantId_fkey";
ALTER TABLE "WebhookInbox"
  ADD CONSTRAINT "WebhookInbox_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "FollowUpCampaign" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "policy" JSONB NOT NULL DEFAULT '{}',
    "template" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FollowUpCampaign_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "FollowUpCampaign_tenantId_name_key" ON "FollowUpCampaign"("tenantId", "name");
CREATE INDEX IF NOT EXISTS "FollowUpCampaign_tenantId_enabled_idx" ON "FollowUpCampaign"("tenantId", "enabled");
ALTER TABLE "FollowUpCampaign"
  DROP CONSTRAINT IF EXISTS "FollowUpCampaign_tenantId_fkey";
ALTER TABLE "FollowUpCampaign"
  ADD CONSTRAINT "FollowUpCampaign_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
