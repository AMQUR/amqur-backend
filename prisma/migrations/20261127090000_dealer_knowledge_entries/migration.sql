-- Additive: one new table. No existing table is altered.
CREATE TABLE "DealerKnowledgeEntry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "department" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewByDays" INTEGER NOT NULL DEFAULT 90,
    "expiresAt" TIMESTAMP(3),
    "proposedById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "supersedesId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DealerKnowledgeEntry_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DealerKnowledgeEntry_tenantId_locationId_kind_status_idx" ON "DealerKnowledgeEntry"("tenantId", "locationId", "kind", "status");
