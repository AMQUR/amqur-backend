-- CSI retention: sales/service kind, staff templates, manager follow-up queue.
-- Not OEM CSI. No auto-SMS send path.

CREATE TYPE "CustomerSurveyKind" AS ENUM ('SALES', 'SERVICE');
CREATE TYPE "CustomerSurveyFollowUpStatus" AS ENUM ('NONE', 'PENDING', 'ACKNOWLEDGED', 'RESOLVED');

CREATE TABLE IF NOT EXISTS "CustomerSurveyTemplate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT,
    "kind" "CustomerSurveyKind" NOT NULL DEFAULT 'SALES',
    "name" TEXT NOT NULL,
    "scriptBody" TEXT NOT NULL,
    "defaultChannel" TEXT NOT NULL DEFAULT 'IN_PERSON',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerSurveyTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CustomerSurveyTemplate_tenantId_name_key"
  ON "CustomerSurveyTemplate"("tenantId", "name");
CREATE INDEX IF NOT EXISTS "CustomerSurveyTemplate_tenantId_kind_active_idx"
  ON "CustomerSurveyTemplate"("tenantId", "kind", "active");

ALTER TABLE "CustomerSurveyTemplate" ADD CONSTRAINT "CustomerSurveyTemplate_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CustomerSurvey" ADD COLUMN IF NOT EXISTS "appointmentId" TEXT;
ALTER TABLE "CustomerSurvey" ADD COLUMN IF NOT EXISTS "kind" "CustomerSurveyKind" NOT NULL DEFAULT 'SALES';
ALTER TABLE "CustomerSurvey" ADD COLUMN IF NOT EXISTS "templateId" TEXT;
ALTER TABLE "CustomerSurvey" ADD COLUMN IF NOT EXISTS "followUpRequired" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CustomerSurvey" ADD COLUMN IF NOT EXISTS "followUpStatus" "CustomerSurveyFollowUpStatus" NOT NULL DEFAULT 'NONE';
ALTER TABLE "CustomerSurvey" ADD COLUMN IF NOT EXISTS "assignedManagerUserId" TEXT;
ALTER TABLE "CustomerSurvey" ADD COLUMN IF NOT EXISTS "managerNote" TEXT;
ALTER TABLE "CustomerSurvey" ADD COLUMN IF NOT EXISTS "followUpAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "CustomerSurvey_tenantId_kind_status_idx"
  ON "CustomerSurvey"("tenantId", "kind", "status");
CREATE INDEX IF NOT EXISTS "CustomerSurvey_tenantId_followUpStatus_idx"
  ON "CustomerSurvey"("tenantId", "followUpStatus");

ALTER TABLE "CustomerSurvey" ADD CONSTRAINT "CustomerSurvey_templateId_fkey"
  FOREIGN KEY ("templateId") REFERENCES "CustomerSurveyTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
