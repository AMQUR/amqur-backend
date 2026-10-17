-- One active handoff per conversation (matches EscalationsService dedupe statuses).
CREATE UNIQUE INDEX IF NOT EXISTS "Escalation_conversationId_active_key"
ON "Escalation" ("conversationId")
WHERE "conversationId" IS NOT NULL
  AND "status" IN ('OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS');
