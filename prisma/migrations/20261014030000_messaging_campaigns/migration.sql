-- Messaging delivery tracking + campaign versioning (additive)

-- AlterTable
ALTER TABLE "FollowUpCampaign" ADD COLUMN     "createdByUserId" TEXT,
ADD COLUMN     "endsAt" TIMESTAMP(3),
ADD COLUMN     "locationId" TEXT,
ADD COLUMN     "startsAt" TIMESTAMP(3),
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "OutboundMessage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT,
    "conversationId" TEXT,
    "leadId" TEXT,
    "campaignId" TEXT,
    "campaignVersion" INTEGER,
    "channel" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "suppressReason" TEXT,
    "provider" TEXT,
    "providerMessageId" TEXT,
    "error" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboundMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OutboundMessage_tenantId_channel_endpoint_createdAt_idx" ON "OutboundMessage"("tenantId", "channel", "endpoint", "createdAt");

-- CreateIndex
CREATE INDEX "OutboundMessage_providerMessageId_idx" ON "OutboundMessage"("providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundMessage_tenantId_idempotencyKey_key" ON "OutboundMessage"("tenantId", "idempotencyKey");


