-- Additive: when the current claim's handler actually started (NULL = claimed but not started).
-- A lease that expires on a row whose handler never started is not an attempt.
ALTER TABLE "OutboxEvent" ADD COLUMN "handlerStartedAt" TIMESTAMP(3);
