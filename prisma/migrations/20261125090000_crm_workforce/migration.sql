-- CreateEnum
CREATE TYPE "CrmWfControlScope" AS ENUM ('GLOBAL', 'TENANT', 'LOCATION', 'DEPARTMENT', 'WORKFLOW', 'SALESPERSON');

-- CreateEnum
CREATE TYPE "CrmWfMode" AS ENUM ('OBSERVE', 'ASSIST', 'SUPERVISED', 'CONTROLLED_AUTONOMOUS');

-- CreateEnum
CREATE TYPE "CrmWfDepartment" AS ENUM ('SALES', 'SERVICE', 'PARTS');

-- CreateEnum
CREATE TYPE "CrmWfTaskStatus" AS ENUM ('PENDING', 'CLAIMED', 'AWAITING_APPROVAL', 'DONE', 'SUPPRESSED', 'BLOCKED', 'ESCALATED', 'FAILED', 'DEAD', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CrmWfActionStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'QUEUED', 'EXECUTING', 'SENT_UNVERIFIED', 'UNCERTAIN', 'VERIFIED', 'STAFF_CONFIRMED', 'BLOCKED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CrmWfSideEffect" AS ENUM ('READ_ONLY', 'DRAFT_ONLY', 'EXTERNAL');

-- CreateTable
CREATE TABLE "CrmWfControl" (
    "id" TEXT NOT NULL,
    "scope" "CrmWfControlScope" NOT NULL,
    "tenantId" TEXT,
    "locationId" TEXT,
    "department" "CrmWfDepartment",
    "subjectKey" TEXT,
    "scopeKey" TEXT NOT NULL,
    "halted" BOOLEAN NOT NULL DEFAULT false,
    "mode" "CrmWfMode",
    "externalSendEnabled" BOOLEAN,
    "authorization" JSONB,
    "reason" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmWfControl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmWfAgentProfile" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "department" "CrmWfDepartment" NOT NULL,
    "displayName" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "disclosure" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmWfAgentProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmWfConnector" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "adapterKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'DISABLED',
    "statusReason" TEXT,
    "authorizationRef" TEXT,
    "authorizedAt" TIMESTAMP(3),
    "authorizedByUserId" TEXT,
    "lastHealthAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmWfConnector_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmWfLead" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "adapterKey" TEXT NOT NULL,
    "sourceRecordId" TEXT NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "synthetic" BOOLEAN NOT NULL DEFAULT false,
    "department" "CrmWfDepartment" NOT NULL DEFAULT 'SALES',
    "firstName" TEXT,
    "lastNameEnc" TEXT,
    "phoneEnc" TEXT,
    "emailEnc" TEXT,
    "phoneHash" TEXT,
    "emailHash" TEXT,
    "phoneLast4" TEXT,
    "duplicateOfId" TEXT,
    "importBatchId" TEXT,
    "lastImportBatchId" TEXT,
    "language" TEXT,
    "leadSource" TEXT,
    "crmStatus" TEXT,
    "assignedTo" TEXT,
    "vehicleInterest" JSONB,
    "createdInCrmAt" TIMESTAMP(3),
    "lastInboundAt" TIMESTAMP(3),
    "lastOutboundAt" TIMESTAMP(3),
    "hasFutureFollowUp" BOOLEAN NOT NULL DEFAULT false,
    "appointmentState" TEXT NOT NULL DEFAULT 'NONE',
    "appointmentAt" TIMESTAMP(3),
    "visitedAt" TIMESTAMP(3),
    "crmDoNotContact" BOOLEAN,
    "humanActiveUntil" TIMESTAMP(3),
    "agentPaused" BOOLEAN NOT NULL DEFAULT false,
    "pausedReason" TEXT,
    "pausedByUserId" TEXT,
    "linkedLeadId" TEXT,
    "contentHash" TEXT,
    "lastProcessedHash" TEXT,
    "lastProcessedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmWfLead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmWfMessage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "crmLeadId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "authorType" TEXT NOT NULL,
    "bodyEnc" TEXT NOT NULL,
    "importBatchId" TEXT,
    "sourceRecordId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmWfMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmWfTask" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "crmLeadId" TEXT NOT NULL,
    "department" "CrmWfDepartment" NOT NULL,
    "agentKey" TEXT NOT NULL,
    "workflowKey" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "evidence" JSONB NOT NULL,
    "status" "CrmWfTaskStatus" NOT NULL DEFAULT 'PENDING',
    "statusReason" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "claimedAt" TIMESTAMP(3),
    "claimedBy" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "handlerStartedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmWfTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmWfAction" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "crmLeadId" TEXT,
    "taskId" TEXT,
    "department" "CrmWfDepartment",
    "actionType" TEXT NOT NULL,
    "sideEffect" "CrmWfSideEffect" NOT NULL,
    "adapterKey" TEXT,
    "channel" TEXT,
    "payload" JSONB NOT NULL,
    "status" "CrmWfActionStatus" NOT NULL DEFAULT 'DRAFT',
    "statusReason" TEXT,
    "complianceDecision" JSONB,
    "verification" JSONB,
    "externalRef" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "playbookKey" TEXT,
    "playbookVersion" INTEGER,
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmWfAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmWfSuppression" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "endpointHash" TEXT NOT NULL,
    "hint" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "crmLeadId" TEXT,
    "createdByUserId" TEXT,
    "liftedAt" TIMESTAMP(3),
    "liftedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmWfSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmWfUsage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT,
    "taskId" TEXT,
    "crmLeadId" TEXT,
    "kind" TEXT NOT NULL,
    "provider" TEXT,
    "model" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "cached" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmWfUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmWfHeartbeat" (
    "id" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "detail" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastBeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmWfHeartbeat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmWfReview" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "correctedBody" TEXT,
    "note" TEXT,
    "reviewerUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmWfReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmWfOutcome" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "crmLeadId" TEXT NOT NULL,
    "department" "CrmWfDepartment" NOT NULL,
    "kind" TEXT NOT NULL,
    "basis" TEXT NOT NULL,
    "sourceRecordId" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmWfOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmWfImportBatch" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PREVIEWED',
    "fileName" TEXT,
    "fileSha256" TEXT NOT NULL,
    "exportedAt" TIMESTAMP(3) NOT NULL,
    "synthetic" BOOLEAN NOT NULL DEFAULT false,
    "mapping" JSONB NOT NULL,
    "counts" JSONB NOT NULL,
    "validation" JSONB NOT NULL,
    "authorizationRef" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "committedAt" TIMESTAMP(3),
    "rolledBackAt" TIMESTAMP(3),
    "rolledBackByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmWfImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmWfImportChange" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "crmLeadId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "before" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmWfImportChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmWfWorkItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "crmLeadId" TEXT,
    "department" "CrmWfDepartment" NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "urgency" TEXT NOT NULL DEFAULT 'NORMAL',
    "title" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "dueAt" TIMESTAMP(3),
    "assigneeName" TEXT,
    "assignedUserId" TEXT,
    "createdBy" TEXT NOT NULL,
    "resolution" JSONB,
    "resolvedByUserId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmWfWorkItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CrmWfControl_scopeKey_key" ON "CrmWfControl"("scopeKey");

-- CreateIndex
CREATE INDEX "CrmWfControl_tenantId_locationId_idx" ON "CrmWfControl"("tenantId", "locationId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmWfAgentProfile_tenantId_locationId_department_key" ON "CrmWfAgentProfile"("tenantId", "locationId", "department");

-- CreateIndex
CREATE UNIQUE INDEX "CrmWfConnector_tenantId_locationId_adapterKey_key" ON "CrmWfConnector"("tenantId", "locationId", "adapterKey");

-- CreateIndex
CREATE INDEX "CrmWfLead_tenantId_locationId_department_idx" ON "CrmWfLead"("tenantId", "locationId", "department");

-- CreateIndex
CREATE INDEX "CrmWfLead_tenantId_phoneHash_idx" ON "CrmWfLead"("tenantId", "phoneHash");

-- CreateIndex
CREATE INDEX "CrmWfLead_tenantId_emailHash_idx" ON "CrmWfLead"("tenantId", "emailHash");

-- CreateIndex
CREATE INDEX "CrmWfLead_tenantId_importBatchId_idx" ON "CrmWfLead"("tenantId", "importBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmWfLead_tenantId_adapterKey_sourceRecordId_key" ON "CrmWfLead"("tenantId", "adapterKey", "sourceRecordId");

-- CreateIndex
CREATE INDEX "CrmWfMessage_crmLeadId_occurredAt_idx" ON "CrmWfMessage"("crmLeadId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "CrmWfMessage_crmLeadId_sourceRecordId_key" ON "CrmWfMessage"("crmLeadId", "sourceRecordId");

-- CreateIndex
CREATE INDEX "CrmWfTask_status_priority_nextAttemptAt_idx" ON "CrmWfTask"("status", "priority", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "CrmWfTask_status_leaseExpiresAt_idx" ON "CrmWfTask"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "CrmWfTask_tenantId_locationId_status_idx" ON "CrmWfTask"("tenantId", "locationId", "status");

-- CreateIndex
CREATE INDEX "CrmWfTask_crmLeadId_idx" ON "CrmWfTask"("crmLeadId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmWfTask_tenantId_dedupeKey_key" ON "CrmWfTask"("tenantId", "dedupeKey");

-- CreateIndex
CREATE INDEX "CrmWfAction_tenantId_locationId_status_createdAt_idx" ON "CrmWfAction"("tenantId", "locationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "CrmWfAction_crmLeadId_createdAt_idx" ON "CrmWfAction"("crmLeadId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CrmWfAction_tenantId_idempotencyKey_key" ON "CrmWfAction"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "CrmWfSuppression_tenantId_endpointHash_idx" ON "CrmWfSuppression"("tenantId", "endpointHash");

-- CreateIndex
CREATE INDEX "CrmWfSuppression_tenantId_createdAt_idx" ON "CrmWfSuppression"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "CrmWfUsage_tenantId_createdAt_idx" ON "CrmWfUsage"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CrmWfHeartbeat_workerId_key" ON "CrmWfHeartbeat"("workerId");

-- CreateIndex
CREATE INDEX "CrmWfReview_tenantId_locationId_createdAt_idx" ON "CrmWfReview"("tenantId", "locationId", "createdAt");

-- CreateIndex
CREATE INDEX "CrmWfReview_actionId_idx" ON "CrmWfReview"("actionId");

-- CreateIndex
CREATE INDEX "CrmWfOutcome_tenantId_locationId_kind_occurredAt_idx" ON "CrmWfOutcome"("tenantId", "locationId", "kind", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "CrmWfOutcome_tenantId_crmLeadId_kind_sourceRecordId_key" ON "CrmWfOutcome"("tenantId", "crmLeadId", "kind", "sourceRecordId");

-- CreateIndex
CREATE INDEX "CrmWfImportBatch_tenantId_locationId_createdAt_idx" ON "CrmWfImportBatch"("tenantId", "locationId", "createdAt");

-- CreateIndex
CREATE INDEX "CrmWfImportChange_batchId_idx" ON "CrmWfImportChange"("batchId");

-- CreateIndex
CREATE INDEX "CrmWfImportChange_tenantId_crmLeadId_idx" ON "CrmWfImportChange"("tenantId", "crmLeadId");

-- CreateIndex
CREATE INDEX "CrmWfWorkItem_tenantId_locationId_status_kind_idx" ON "CrmWfWorkItem"("tenantId", "locationId", "status", "kind");

-- CreateIndex
CREATE INDEX "CrmWfWorkItem_crmLeadId_idx" ON "CrmWfWorkItem"("crmLeadId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmWfWorkItem_tenantId_dedupeKey_key" ON "CrmWfWorkItem"("tenantId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "CrmWfMessage" ADD CONSTRAINT "CrmWfMessage_crmLeadId_fkey" FOREIGN KEY ("crmLeadId") REFERENCES "CrmWfLead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

