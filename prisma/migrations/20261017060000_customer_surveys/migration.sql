-- Internal CSI/CSAT drafts — no auto-send. Scores only when status=RESPONDED.
CREATE TYPE "CustomerSurveyStatus" AS ENUM ('DRAFT', 'QUEUED', 'SENT', 'RESPONDED', 'CLOSED', 'CANCELLED');

CREATE TABLE IF NOT EXISTS "CustomerSurvey" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT,
    "leadId" TEXT,
    "conversationId" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'LINK',
    "status" "CustomerSurveyStatus" NOT NULL DEFAULT 'DRAFT',
    "score" INTEGER,
    "comment" TEXT,
    "sentAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerSurvey_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CustomerSurvey_tenantId_status_idx" ON "CustomerSurvey"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "CustomerSurvey_tenantId_locationId_idx" ON "CustomerSurvey"("tenantId", "locationId");
CREATE INDEX IF NOT EXISTS "CustomerSurvey_leadId_idx" ON "CustomerSurvey"("leadId");

ALTER TABLE "CustomerSurvey" ADD CONSTRAINT "CustomerSurvey_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
