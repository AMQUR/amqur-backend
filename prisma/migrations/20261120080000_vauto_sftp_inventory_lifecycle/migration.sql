-- vAuto Dial Difference SFTP: per-source lifecycle + never infer SOLD from absence.

ALTER TYPE "VehicleStatus" ADD VALUE IF NOT EXISTS 'PENDING_RECONCILIATION';
ALTER TYPE "VehicleStatus" ADD VALUE IF NOT EXISTS 'REMOVED_FROM_LISTING';
ALTER TYPE "VehicleStatus" ADD VALUE IF NOT EXISTS 'QUARANTINED';

ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "feedSourceKey" TEXT;
ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "listingRemovedAt" TIMESTAMP(3);
ALTER TABLE "Vehicle" ADD COLUMN IF NOT EXISTS "explicitSoldEvidence" TEXT;

CREATE INDEX IF NOT EXISTS "Vehicle_tenantId_feedSourceKey_idx" ON "Vehicle"("tenantId", "feedSourceKey");
CREATE INDEX IF NOT EXISTS "Vehicle_locationId_feedSourceKey_status_idx" ON "Vehicle"("locationId", "feedSourceKey", "status");

ALTER TABLE "InventoryImportRun" ADD COLUMN IF NOT EXISTS "feedSourceKey" TEXT;
ALTER TABLE "InventoryImportRun" ADD COLUMN IF NOT EXISTS "sourceCondition" TEXT;

CREATE INDEX IF NOT EXISTS "InventoryImportRun_feedSourceKey_startedAt_idx" ON "InventoryImportRun"("feedSourceKey", "startedAt");
