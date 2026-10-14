-- Copy experiments (additive)
CREATE TABLE "Experiment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT,
    "key" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "variants" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdById" TEXT,
    "startedById" TEXT,
    "startedAt" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Experiment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Experiment_tenantId_key_key" ON "Experiment"("tenantId", "key");
CREATE INDEX "Experiment_tenantId_status_idx" ON "Experiment"("tenantId", "status");
