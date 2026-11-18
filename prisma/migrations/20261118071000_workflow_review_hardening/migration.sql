-- AlterTable
ALTER TABLE "WorkflowDefinition" ADD COLUMN "lastEditedByUserId" TEXT,
ADD COLUMN "pendingRestoreFromVersion" INTEGER;
