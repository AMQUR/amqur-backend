-- Per-rooftop ADF/XML lead delivery (additive). See docs/ADF_LEAD_DELIVERY.md.
-- New enums + three new tables only; no existing table, column or constraint is altered.

-- CreateEnum
CREATE TYPE "LeadDeliveryChannel" AS ENUM ('ADF_EMAIL');

-- CreateEnum
CREATE TYPE "LeadDeliveryDepartment" AS ENUM ('SALES', 'SERVICE', 'PARTS');

-- CreateEnum
CREATE TYPE "LeadDeliveryStatus" AS ENUM ('QUEUED', 'SENT', 'ACCEPTED', 'DELIVERED', 'CRM_PARSED', 'CRM_MATCHED', 'CRM_REJECTED', 'FAILED', 'DEAD', 'BLOCKED');

-- CreateEnum
CREATE TYPE "LeadDeliveryFormat" AS ENUM ('XML_BODY', 'XML_ATTACHMENT');

-- CreateEnum
CREATE TYPE "LeadDeliveryRouteEnvironment" AS ENUM ('SANDBOX', 'PRODUCTION');

-- CreateTable
CREATE TABLE "LeadDeliveryRoute" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "channel" "LeadDeliveryChannel" NOT NULL DEFAULT 'ADF_EMAIL',
    "department" "LeadDeliveryDepartment" NOT NULL,
    "environment" "LeadDeliveryRouteEnvironment" NOT NULL DEFAULT 'SANDBOX',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "destinationCiphertext" TEXT NOT NULL,
    "destinationIv" TEXT NOT NULL,
    "destinationAuthTag" TEXT NOT NULL,
    "destinationFingerprint" TEXT NOT NULL,
    "destinationMasked" TEXT NOT NULL,
    "format" "LeadDeliveryFormat" NOT NULL DEFAULT 'XML_BODY',
    "adfVersion" TEXT NOT NULL DEFAULT '1.0',
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "verifiedBy" TEXT,
    "verificationEvidence" TEXT,
    "productionEnabled" BOOLEAN NOT NULL DEFAULT false,
    "productionEnabledAt" TIMESTAMP(3),
    "productionEnabledBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadDeliveryRoute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadDelivery" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT,
    "leadId" TEXT NOT NULL,
    "channel" "LeadDeliveryChannel" NOT NULL DEFAULT 'ADF_EMAIL',
    "department" "LeadDeliveryDepartment" NOT NULL,
    "routeId" TEXT,
    "destinationFingerprint" TEXT,
    "destinationMasked" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "status" "LeadDeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "replayCount" INTEGER NOT NULL DEFAULT 0,
    "providerName" TEXT,
    "providerMessageId" TEXT,
    "providerRawStatus" TEXT,
    "crmRecordRef" TEXT,
    "payloadSha256" TEXT,
    "payloadBytes" INTEGER,
    "blockedReason" TEXT,
    "lastErrorCode" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "crmParsedAt" TIMESTAMP(3),
    "crmMatchedAt" TIMESTAMP(3),
    "crmRejectedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "deadAt" TIMESTAMP(3),
    "blockedAt" TIMESTAMP(3),
    "correlationId" TEXT NOT NULL,
    "outboxEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadDeliveryEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "fromStatus" "LeadDeliveryStatus",
    "toStatus" "LeadDeliveryStatus" NOT NULL,
    "reasonCode" TEXT,
    "evidence" JSONB,
    "actor" TEXT NOT NULL DEFAULT 'system',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadDeliveryEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LeadDeliveryRoute_tenantId_enabled_idx" ON "LeadDeliveryRoute"("tenantId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "LeadDeliveryRoute_tenantId_locationId_channel_department_key" ON "LeadDeliveryRoute"("tenantId", "locationId", "channel", "department");

-- CreateIndex
CREATE UNIQUE INDEX "LeadDeliveryRoute_id_tenantId_key" ON "LeadDeliveryRoute"("id", "tenantId");

-- CreateIndex
CREATE INDEX "LeadDelivery_tenantId_status_createdAt_idx" ON "LeadDelivery"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "LeadDelivery_tenantId_locationId_status_idx" ON "LeadDelivery"("tenantId", "locationId", "status");

-- CreateIndex
CREATE INDEX "LeadDelivery_leadId_idx" ON "LeadDelivery"("leadId");

-- CreateIndex
CREATE UNIQUE INDEX "LeadDelivery_tenantId_idempotencyKey_key" ON "LeadDelivery"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "LeadDeliveryEvent_deliveryId_createdAt_idx" ON "LeadDeliveryEvent"("deliveryId", "createdAt");

-- CreateIndex
CREATE INDEX "LeadDeliveryEvent_tenantId_createdAt_idx" ON "LeadDeliveryEvent"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "LeadDeliveryRoute" ADD CONSTRAINT "LeadDeliveryRoute_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadDeliveryRoute" ADD CONSTRAINT "LeadDeliveryRoute_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadDelivery" ADD CONSTRAINT "LeadDelivery_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadDelivery" ADD CONSTRAINT "LeadDelivery_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadDelivery" ADD CONSTRAINT "LeadDelivery_routeId_tenantId_fkey" FOREIGN KEY ("routeId", "tenantId") REFERENCES "LeadDeliveryRoute"("id", "tenantId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "LeadDeliveryEvent" ADD CONSTRAINT "LeadDeliveryEvent_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "LeadDelivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Fail-closed invariants enforced by the database, not only by application code.
-- A route can be production-enabled only if it is a verified PRODUCTION route.
ALTER TABLE "LeadDeliveryRoute" ADD CONSTRAINT "LeadDeliveryRoute_production_requires_verified_chk"
  CHECK (NOT "productionEnabled" OR ("verified" AND "environment" = 'PRODUCTION'));

-- "verified" always carries who/when/evidence.
ALTER TABLE "LeadDeliveryRoute" ADD CONSTRAINT "LeadDeliveryRoute_verified_requires_evidence_chk"
  CHECK (NOT "verified" OR ("verifiedAt" IS NOT NULL AND "verifiedBy" IS NOT NULL AND "verificationEvidence" IS NOT NULL));

-- CRM_MATCHED is only ever recorded with a CRM record reference.
ALTER TABLE "LeadDelivery" ADD CONSTRAINT "LeadDelivery_crm_matched_requires_ref_chk"
  CHECK ("status" <> 'CRM_MATCHED' OR "crmRecordRef" IS NOT NULL);

-- ACCEPTED (and everything after it) is only ever recorded with a provider acknowledgement.
ALTER TABLE "LeadDelivery" ADD CONSTRAINT "LeadDelivery_accepted_requires_receipt_chk"
  CHECK ("status" NOT IN ('ACCEPTED', 'DELIVERED', 'CRM_PARSED', 'CRM_MATCHED', 'CRM_REJECTED')
         OR ("providerName" IS NOT NULL AND "providerMessageId" IS NOT NULL AND "acceptedAt" IS NOT NULL AND "routeId" IS NOT NULL));
