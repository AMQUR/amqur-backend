# Backup and restore

**Status: NOT VERIFIED (blocker B-11).** Do not open broad public traffic until completed.

## Required evidence

1. Railway Postgres plan supports scheduled backups (and PITR if available); record schedule + retention.
2. Restore drill into a **non-production** Railway environment:
   - pick a backup ≥24 h old; restore to a new database;
   - point a temporary API at it (`DATABASE_URL`), run `npx prisma migrate status` (no pending/failed);
   - verify row counts for Tenant, Conversation, Lead, Appointment, ConsentRecord, AuditLog vs. source snapshot;
   - log in to Command Center against it; open a conversation;
   - destroy the temporary environment.
3. Record date, operator, backup id, RPO/RTO observed in `docs/evidence/`.

## Safety rules

- Migrations are additive; CI blocks DROP TABLE/TRUNCATE patterns.
- Never restore over production without a fresh backup of current state.
- Consent and audit tables must be restored together with leads (opt-out integrity).
