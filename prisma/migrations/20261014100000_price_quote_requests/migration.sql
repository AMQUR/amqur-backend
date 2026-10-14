-- Out-the-door price quote requests (additive)
CREATE TABLE "PriceQuoteRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT,
    "conversationId" TEXT,
    "vehicleVin" TEXT NOT NULL,
    "vehicleLabel" TEXT,
    "paymentMethod" TEXT NOT NULL DEFAULT 'UNDECIDED',
    "registrationZip" TEXT,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "estimateShown" JSONB,
    "missingInputs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "customerName" TEXT,
    "customerPhone" TEXT,
    "customerEmail" TEXT,
    "provenance" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PriceQuoteRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PriceQuoteRequest_tenantId_conversationId_vehicleVin_key" ON "PriceQuoteRequest"("tenantId", "conversationId", "vehicleVin");
CREATE INDEX "PriceQuoteRequest_tenantId_status_idx" ON "PriceQuoteRequest"("tenantId", "status");
ALTER TABLE "PriceQuoteRequest" ADD CONSTRAINT "PriceQuoteRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PriceQuoteRequest" ADD CONSTRAINT "PriceQuoteRequest_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
