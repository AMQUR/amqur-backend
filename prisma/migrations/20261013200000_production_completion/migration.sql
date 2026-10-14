-- Production completion: additive only (no drops, no rewrites of existing data).
-- Pre-existing schema drift (FK re-create, updatedAt default, index rename) intentionally excluded; see docs/PRODUCTION_READINESS.md.

-- AlterEnum
ALTER TYPE "AppointmentStatus" ADD VALUE 'RESCHEDULED';

-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "canceledAt" TIMESTAMP(3),
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "externalProviderId" TEXT,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "leadId" TEXT,
ADD COLUMN     "provenance" JSONB,
ADD COLUMN     "provider" TEXT NOT NULL DEFAULT 'NONE',
ADD COLUMN     "providerStatus" TEXT,
ADD COLUMN     "requestedAt" TIMESTAMP(3),
ADD COLUMN     "requestedPhrase" TEXT,
ADD COLUMN     "rescheduledFromId" TEXT,
ADD COLUMN     "serviceType" TEXT,
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'America/Chicago',
ADD COLUMN     "transportation" TEXT;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "aiPaused" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "assignedUserId" TEXT,
ADD COLUMN     "handoffState" TEXT NOT NULL DEFAULT 'AI',
ADD COLUMN     "language" TEXT,
ADD COLUMN     "stateVersion" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "FinanceRequest" ADD COLUMN     "aprSource" TEXT NOT NULL DEFAULT 'NONE',
ADD COLUMN     "creditLinkClickedAt" TIMESTAMP(3),
ADD COLUMN     "creditLinkOfferedAt" TIMESTAMP(3),
ADD COLUMN     "creditLinkState" TEXT NOT NULL DEFAULT 'NONE',
ADD COLUMN     "handoffState" TEXT NOT NULL DEFAULT 'NONE',
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "provenance" JSONB;

-- AlterTable
ALTER TABLE "Location" ADD COLUMN     "creditApplication" JSONB,
ADD COLUMN     "departmentHours" JSONB,
ADD COLUMN     "financialPolicy" JSONB,
ADD COLUMN     "holidayHours" JSONB,
ADD COLUMN     "serviceAmenities" JSONB,
ADD COLUMN     "storeHoursVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "storeHoursVerifiedBy" TEXT;

-- AlterTable
ALTER TABLE "OutboxEvent" ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "claimedBy" TEXT,
ADD COLUMN     "leaseExpiresAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PartsInquiry" ADD COLUMN     "etaVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "fitmentSource" TEXT,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "installAppointmentId" TEXT,
ADD COLUMN     "installationRequested" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "partNumber" TEXT,
ADD COLUMN     "preferredAction" TEXT,
ADD COLUMN     "provenance" JSONB,
ADD COLUMN     "providerReference" TEXT,
ADD COLUMN     "suspectedPart" TEXT,
ADD COLUMN     "vehicleMake" TEXT,
ADD COLUMN     "vehicleModel" TEXT,
ADD COLUMN     "vehicleYear" INTEGER;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "creditApplication" JSONB,
ADD COLUMN     "financialPolicy" JSONB;

-- CreateTable
CREATE TABLE "ConsentRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT,
    "leadId" TEXT,
    "conversationExternalKey" TEXT,
    "channel" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "wording" TEXT,
    "wordingVersion" TEXT,
    "source" TEXT NOT NULL,
    "evidence" JSONB,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConsentRecord_tenantId_channel_endpoint_createdAt_idx" ON "ConsentRecord"("tenantId", "channel", "endpoint", "createdAt");

-- CreateIndex
CREATE INDEX "ConsentRecord_tenantId_leadId_idx" ON "ConsentRecord"("tenantId", "leadId");

-- CreateIndex
CREATE INDEX "Appointment_tenantId_locationId_requestedAt_idx" ON "Appointment"("tenantId", "locationId", "requestedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Appointment_tenantId_idempotencyKey_key" ON "Appointment"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "FinanceRequest_conversationId_idx" ON "FinanceRequest"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceRequest_tenantId_idempotencyKey_key" ON "FinanceRequest"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_leaseExpiresAt_idx" ON "OutboxEvent"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "PartsInquiry_conversationId_idx" ON "PartsInquiry"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "PartsInquiry_tenantId_idempotencyKey_key" ON "PartsInquiry"("tenantId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

