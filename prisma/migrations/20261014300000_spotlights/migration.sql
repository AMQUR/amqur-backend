-- Dealer-managed spotlights (additive)
CREATE TABLE "Spotlight" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "linkUrl" TEXT,
    "vehicleVin" TEXT,
    "source" TEXT,
    "disclaimer" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Spotlight_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Spotlight_tenantId_locationId_status_idx" ON "Spotlight"("tenantId", "locationId", "status");
