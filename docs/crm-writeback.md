# CRM writeback

`TekionCrmWritebackService` upserts leads idempotently.
Duplicates are prevented with `idempotencyKey = lead:{tenant}:{conversation}:{email|phone}`.
Outbox topic: `integration.tekion.lead-writeback`.
Live Tekion remains off until `liveReady`.
