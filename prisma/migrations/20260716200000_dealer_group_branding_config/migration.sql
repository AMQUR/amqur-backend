-- DealerGroup + memberships for authorized group reporting (does not weaken tenant isolation)
CREATE TYPE "DealerGroupRole" AS ENUM ('GROUP_VIEWER', 'GROUP_ADMIN');

CREATE TABLE "DealerGroup" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DealerGroup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DealerGroup_slug_key" ON "DealerGroup"("slug");

CREATE TABLE "DealerGroupMembership" (
    "id" TEXT NOT NULL,
    "dealerGroupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "DealerGroupRole" NOT NULL DEFAULT 'GROUP_VIEWER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DealerGroupMembership_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DealerGroupMembership_dealerGroupId_userId_key" ON "DealerGroupMembership"("dealerGroupId", "userId");
CREATE INDEX "DealerGroupMembership_userId_idx" ON "DealerGroupMembership"("userId");
CREATE INDEX "DealerGroupMembership_dealerGroupId_idx" ON "DealerGroupMembership"("dealerGroupId");

ALTER TABLE "DealerGroupMembership" ADD CONSTRAINT "DealerGroupMembership_dealerGroupId_fkey" FOREIGN KEY ("dealerGroupId") REFERENCES "DealerGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant branding / group / retention
ALTER TABLE "Tenant" ADD COLUMN "dealerGroupId" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "publicConfig" JSONB;
ALTER TABLE "Tenant" ADD COLUMN "configVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Tenant" ADD COLUMN "dataRetentionDays" INTEGER NOT NULL DEFAULT 365;
ALTER TABLE "Tenant" ADD COLUMN "consentText" TEXT;

CREATE INDEX "Tenant_dealerGroupId_idx" ON "Tenant"("dealerGroupId");

ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_dealerGroupId_fkey" FOREIGN KEY ("dealerGroupId") REFERENCES "DealerGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Location branding + escalation recipients
ALTER TABLE "Location" ADD COLUMN "publicConfig" JSONB;
ALTER TABLE "Location" ADD COLUMN "escalationRecipients" TEXT;
