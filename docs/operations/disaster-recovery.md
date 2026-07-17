# Disaster recovery

## Backups

**Staging PostgreSQL** runs as a Railway service with a persistent volume
(`postgres-volume`, mounted at `/var/lib/postgresql/data`). Railway provides
volume backups (daily snapshots on paid plans) — **retention and schedule
are configured in the Railway dashboard, not the CLI; the owner must verify
snapshot schedule + retention there** (Project → Postgres → Volume →
Backups). Do not assume backups exist until the dashboard shows snapshots.

**Logical backups (recommended in addition to snapshots):** the database is
also dumpable at any time via the public connection URL:

```bash
# never print the URL; postgres server is 18.x — use a matching client
PGURL="$(railway variables --service Postgres --environment staging --kv | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)"
docker run --rm -e PGURL postgres:18-alpine sh -c 'pg_dump "$PGURL" --no-owner --no-privileges' > backup.sql
```

Store dumps encrypted, never in Git.

## Restore procedure (verified by drill)

**Rule: never restore over the active staging or production database.**
Restore into a fresh database/service, verify, then repoint or migrate.

Drill executed 2026-07-16 with disposable data (local dev DB → tmpfs test
container, identical dump/restore tooling):

| Step | Result |
|---|---|
| `pg_dump --no-owner --no-privileges` | exit 0 |
| restore into fresh `restore_drill` database via `psql < dump` | exit 0, zero errors |
| table count source vs restored | 25 = 25 |
| `Tenant` / `Location` / `_prisma_migrations` rows | 2/2/8 = 2/2/8 |

Procedure:

1. Create a fresh database (new Railway PG service, or `CREATE DATABASE`).
2. `psql "<fresh-url>" < backup.sql`
3. Verify: table count, `_prisma_migrations` row count matches
   `prisma/migrations/`, spot-check `Tenant`/`Location`/`Lead` counts.
4. Run `npx prisma migrate status` against the restored DB — must report
   up to date (or apply the tail with `migrate deploy`).
5. Point the api/worker `DATABASE_URL` at the restored instance
   (Railway variable change + redeploy) only after verification.

## Durable handoff / queue recovery

- **Persistence:** escalations and lead handoffs are written to the
  `OutboxEvent` table inside the same transaction as the business record —
  a worker crash never loses an accepted handoff.
- **Retry:** the outbox processor claims PENDING rows each minute, with
  bounded attempts and `nextAttemptAt` backoff; rows exceeding max attempts
  become `DEAD` (dead-letter) with `lastError` retained.
- **Idempotency:** `@@unique([tenantId, idempotencyKey])` prevents duplicate
  submissions from producing duplicate outbound deliveries
  (e.g. `escalation-notify:<id>`).
- **Worker restart:** rows stuck in `PROCESSING` after a crash are subject
  to reclaim on the next tick; the worker is stateless — Railway's restart
  policy (`ON_FAILURE`, 10 retries) plus healthcheck cover recovery.

### DLQ inspection (runbook query)

```sql
SELECT id, "tenantId", topic, attempts, "lastError", "updatedAt"
FROM "OutboxEvent" WHERE status IN ('FAILED','DEAD')
ORDER BY "updatedAt" DESC LIMIT 50;
```

Re-drive after fixing the cause:

```sql
UPDATE "OutboxEvent" SET status='PENDING', "nextAttemptAt"=now()
WHERE status='DEAD' AND id = '<id>';
```

## Redis loss

Redis stores short-TTL config cache + rate-limit state only. Full loss
degrades to direct DB reads (health reports `redis: down`, readiness stays
up). No recovery steps beyond restoring the service.

## Staging-dump drill (2026-07-16, second drill)

Executed against a REAL staging dump (pg18 client → disposable tmpfs
container, dropped immediately after):

| Step | Result |
|---|---|
| `pg_dump` (postgres:18-alpine) of staging via `DATABASE_PUBLIC_URL` | exit 0, 66 KB |
| restore into fresh `staging_drill` database | exit 0 |
| errors | 1 benign: `unrecognized configuration parameter "transaction_timeout"` (pg18 dump preamble vs pg16 drill target; harmless on same-version restore, no data impact) |
| tables / `Tenant` / `Location` / `_prisma_migrations` | 25/25 · 5/5 · 5/5 · 8/8 source = restored |

Dump file and drill database were destroyed after verification.

## Open owner items

- Verify Railway volume snapshot schedule/retention in the dashboard.
- Decide cadence + storage location for encrypted logical dumps.
