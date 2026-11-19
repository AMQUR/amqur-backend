-- R8: "lead first, appointment as a separate update" (proposed policy; docs/ADF_LEAD_DELIVERY.md).
-- ADDITIVE ONLY: three new enums, one new table, and one new column with a default on
-- "LeadDeliveryRoute". No existing column, constraint or row is changed, so code that predates
-- this migration keeps running against the new schema (it never reads the new column or table).

-- CreateEnum
CREATE TYPE "LeadDeliveryAppointmentUpdates" AS ENUM ('NONE', 'ADF_FOLLOW_UP');

-- CreateEnum
CREATE TYPE "LeadAppointmentUpdateState" AS ENUM ('REQUESTED', 'SCHEDULED', 'CONFIRMED', 'CANCELLED', 'RESCHEDULED', 'FAILED');

-- CreateEnum
CREATE TYPE "LeadAppointmentUpdateStatus" AS ENUM ('NOT_SENT', 'WAITING_FOR_LEAD', 'QUEUED', 'SENT', 'ACCEPTED', 'FAILED', 'DEAD', 'BLOCKED');

-- AlterTable: default NONE — no destination accepts appointment updates until someone says so.
ALTER TABLE "LeadDeliveryRoute" ADD COLUMN     "appointmentUpdates" "LeadDeliveryAppointmentUpdates" NOT NULL DEFAULT 'NONE';

-- CreateTable
CREATE TABLE "LeadAppointmentUpdate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT,
    "leadId" TEXT NOT NULL,
    "leadDeliveryId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "state" "LeadAppointmentUpdateState" NOT NULL,
    "status" "LeadAppointmentUpdateStatus" NOT NULL,
    "leadRef" TEXT NOT NULL,
    "receiptId" TEXT,
    "sandboxReceipt" BOOLEAN NOT NULL DEFAULT false,
    "idempotencyKey" TEXT NOT NULL,
    "reason" TEXT,
    "routeId" TEXT,
    "destinationFingerprint" TEXT,
    "destinationMasked" TEXT,
    "deliveryMode" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "providerName" TEXT,
    "providerMessageId" TEXT,
    "providerRawStatus" TEXT,
    "payloadSha256" TEXT,
    "payloadBytes" INTEGER,
    "lastErrorCode" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "deadAt" TIMESTAMP(3),
    "blockedAt" TIMESTAMP(3),
    "correlationId" TEXT NOT NULL,
    "outboxEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadAppointmentUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LeadAppointmentUpdate_leadDeliveryId_createdAt_idx" ON "LeadAppointmentUpdate"("leadDeliveryId", "createdAt");

-- CreateIndex
CREATE INDEX "LeadAppointmentUpdate_tenantId_appointmentId_idx" ON "LeadAppointmentUpdate"("tenantId", "appointmentId");

-- CreateIndex
CREATE INDEX "LeadAppointmentUpdate_tenantId_leadId_createdAt_idx" ON "LeadAppointmentUpdate"("tenantId", "leadId", "createdAt");

-- CreateIndex
CREATE INDEX "LeadAppointmentUpdate_status_updatedAt_idx" ON "LeadAppointmentUpdate"("status", "updatedAt");

-- CreateIndex: at most ONE update per (lead, appointment, state) — the key is built from them.
CREATE UNIQUE INDEX "LeadAppointmentUpdate_tenantId_idempotencyKey_key" ON "LeadAppointmentUpdate"("tenantId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "LeadAppointmentUpdate" ADD CONSTRAINT "LeadAppointmentUpdate_leadDeliveryId_fkey" FOREIGN KEY ("leadDeliveryId") REFERENCES "LeadDelivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Same rule as "LeadDelivery": the hand-off mode is 'sandbox', 'live' or not recorded.
ALTER TABLE "LeadAppointmentUpdate" ADD CONSTRAINT "LeadAppointmentUpdate_deliveryMode_chk"
  CHECK ("deliveryMode" IS NULL OR "deliveryMode" IN ('sandbox', 'live'));
