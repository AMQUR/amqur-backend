-- CreateEnum
CREATE TYPE "WorkflowRunStatus" AS ENUM ('RUNNING', 'SUSPENDED', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "WorkflowRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT,
    "definitionId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'SIMULATION',
    "status" "WorkflowRunStatus" NOT NULL DEFAULT 'RUNNING',
    "outcome" TEXT,
    "currentNodeId" TEXT,
    "queryRedacted" TEXT NOT NULL,
    "queryLength" INTEGER NOT NULL,
    "idempotencyKey" TEXT,
    "references" JSONB NOT NULL DEFAULT '[]',
    "startedByUserId" TEXT NOT NULL,
    "suspendedAt" TIMESTAMP(3),
    "suspendedExpiresAt" TIMESTAMP(3),
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowStepRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "nodeId" TEXT NOT NULL,
    "nodeType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "output" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowStepRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkflowRun_tenantId_definitionId_createdAt_idx" ON "WorkflowRun"("tenantId", "definitionId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkflowRun_tenantId_status_idx" ON "WorkflowRun"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowRun_tenantId_definitionId_idempotencyKey_key" ON "WorkflowRun"("tenantId", "definitionId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "WorkflowStepRun_tenantId_runId_idx" ON "WorkflowStepRun"("tenantId", "runId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowStepRun_runId_seq_key" ON "WorkflowStepRun"("runId", "seq");

-- AddForeignKey
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "WorkflowDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowStepRun" ADD CONSTRAINT "WorkflowStepRun_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
