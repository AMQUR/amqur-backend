-- CreateEnum
CREATE TYPE "ToolActionStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'DENIED', 'EXPIRED', 'CANCELLED', 'EXECUTED', 'FAILED');

-- CreateTable
CREATE TABLE "ToolActionRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT,
    "toolName" TEXT NOT NULL,
    "toolVersion" INTEGER NOT NULL,
    "input" JSONB NOT NULL,
    "checksum" TEXT NOT NULL,
    "consentRef" TEXT,
    "status" "ToolActionStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "idempotencyKey" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "outboxEventId" TEXT,
    "result" JSONB,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ToolActionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ToolActionRequest_tenantId_idempotencyKey_key" ON "ToolActionRequest"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "ToolActionRequest_tenantId_status_createdAt_idx" ON "ToolActionRequest"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ToolActionRequest_tenantId_locationId_idx" ON "ToolActionRequest"("tenantId", "locationId");

-- AddForeignKey
ALTER TABLE "ToolActionRequest" ADD CONSTRAINT "ToolActionRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
