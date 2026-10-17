-- Trade-in appraisal lifecycle (additive)
ALTER TABLE "TradeRequest" ADD COLUMN "zip" TEXT;
ALTER TABLE "TradeRequest" ADD COLUMN "accidentHistory" TEXT;
ALTER TABLE "TradeRequest" ADD COLUMN "titleStatus" TEXT;

CREATE TABLE "TradeAppraisal" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "tradeRequestId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerRef" TEXT,
    "amount" DOUBLE PRECISION,
    "amountLow" DOUBLE PRECISION,
    "amountHigh" DOUBLE PRECISION,
    "displayPermitted" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "counterAmount" DOUBLE PRECISION,
    "conditionBasis" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TradeAppraisal_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TradeAppraisal_tenantId_tradeRequestId_idx" ON "TradeAppraisal"("tenantId", "tradeRequestId");
CREATE INDEX "TradeAppraisal_tenantId_status_idx" ON "TradeAppraisal"("tenantId", "status");
ALTER TABLE "TradeAppraisal" ADD CONSTRAINT "TradeAppraisal_tradeRequestId_fkey" FOREIGN KEY ("tradeRequestId") REFERENCES "TradeRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
