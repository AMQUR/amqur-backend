-- Explicit retention policy fields (additive)
ALTER TABLE "Tenant" ADD COLUMN "analyticsRetentionDays" INTEGER NOT NULL DEFAULT 400,
ADD COLUMN "legalHold" BOOLEAN NOT NULL DEFAULT false;
