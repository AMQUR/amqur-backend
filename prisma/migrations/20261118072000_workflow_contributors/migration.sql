-- AlterTable
ALTER TABLE "WorkflowDefinition" ADD COLUMN "draftContributorUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Backfill: with no history, the creator, last editor and review requester are all treated as
-- contributors, so none of them can approve or deny an already-open draft (fail closed).
UPDATE "WorkflowDefinition"
SET "draftContributorUserIds" = ARRAY(
  SELECT DISTINCT u FROM unnest(ARRAY[
    "createdByUserId", "lastEditedByUserId", "reviewRequestedByUserId"
  ]) AS u WHERE u IS NOT NULL
);
