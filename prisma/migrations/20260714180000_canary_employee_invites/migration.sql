-- Additive: employee canary invite table for signed short-lived access.
CREATE TABLE "CanaryInvite" (
    "id" TEXT NOT NULL,
    "jti" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "testerLabel" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "redeemedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CanaryInvite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CanaryInvite_jti_key" ON "CanaryInvite"("jti");
CREATE INDEX "CanaryInvite_tenantId_locationId_idx" ON "CanaryInvite"("tenantId", "locationId");
CREATE INDEX "CanaryInvite_expiresAt_idx" ON "CanaryInvite"("expiresAt");

ALTER TABLE "CanaryInvite" ADD CONSTRAINT "CanaryInvite_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
