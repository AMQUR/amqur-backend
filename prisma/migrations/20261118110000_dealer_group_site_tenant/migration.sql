-- Additive: designate the ONE tenant that is a dealer group's own website. Nullable, so every
-- existing group keeps today's behaviour (no cross-rooftop shopping) until it is set.
ALTER TABLE "DealerGroup" ADD COLUMN "groupSiteTenantId" TEXT;

CREATE UNIQUE INDEX "DealerGroup_groupSiteTenantId_key" ON "DealerGroup"("groupSiteTenantId");

ALTER TABLE "DealerGroup" ADD CONSTRAINT "DealerGroup_groupSiteTenantId_fkey" FOREIGN KEY ("groupSiteTenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
