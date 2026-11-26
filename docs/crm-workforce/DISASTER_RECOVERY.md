# Disaster recovery, backups and key custody

**Verified 2026-11-25.** The production database is `Postgres-1bjE` (Railway project `amqur-platform-staging`, environment `production`, database `railway`). This was re-checked before each release. The similarly named `dial-us-now-platform` project is **not** AMQUR production.

## What exists today (evidence)

| Backup | Taken | Size | sha256 (prefix) | Integrity |
|---|---|---|---|---|
| `amqur-backups/amqur-prod-pre-crmwf-20261125.dump.enc` | before R1 | 275,120 B | `8163c1ed` | decrypted + restored in R1 rehearsal |
| `amqur-backups/amqur-prod-pre-crmwf-r2-20261125.dump.enc` | before R2 | 321,248 B | `8c4870f1` | full decrypt + `pg_restore` read |
| `amqur-backups/amqur-prod-pre-crmwf-r3-20261125.dump.enc` | before R3 | 324,496 B | `5a13b341` | **restore rehearsal 2026-11-25** (below) |

Format: `pg_dump -Fc -Z 6`, encrypted with AES-256-CBC, PBKDF2 with 200,000 iterations, before it touches disk. The passphrase is sent over stdin and never written to the server or printed.

**Restore rehearsal (2026-11-25, R3 backup):**
1. Restored into a separate temporary database on the same server. No application pointed at it.
2. Results:
   - Time: 1 s, with 0 restore errors.
   - All 40 migrations present, 0 pending.
   - Row counts matched production for Tenant, Location, User, AuditLog, Lead, ConsentRecord, the CRM Workforce tables and memberships.
   - Production had 1 more conversation and 2 more messages, created by live Concierge traffic after the backup. That is the real recovery-point gap of on-demand backups.
3. The temporary database was then dropped and the decrypted file emptied.

## Gaps, and what closes them

| Gap | Why it matters | Fix | Needs |
|---|---|---|---|
| **All backups sit on the database's own volume** | Losing the volume loses the backups | Off-volume encrypted copies (see below) | Approval **I1** |
| **No schedule**: backups are taken by hand before releases | Recovery point = last release; up to days of Concierge conversations lost | Daily scheduled job | Approval **I1** |
| **Native Railway backups unavailable** on the current plan (`docs/operations/PRODUCTION_BACKUP_EVIDENCE.md`) | No point-in-time recovery | Plan change enabling volume backups, or keep the logical-backup job | Approval **I2** (owner checks the plan price in Railway) |
| **Backup passphrase has one copy**, in `.local-secrets/prod-db-backup-20261125.key` on the owner's machine | Machine loss = backups unreadable | Store it in the owner's password manager / vault; then delete the local file | Owner action **K1** |

### Off-volume backup design (ready to build once I1 is approved)
1. **Storage:** one Railway Bucket (S3-compatible object storage) in the same project. Railway prices storage per GB-month. Each encrypted dump is about 0.3 MB today, so a 30-day daily retention is roughly 10 MB; check the current price in the Railway dashboard before approving. No new vendor.
2. **Job:** a Railway cron service, daily at 03:30 Chicago, image `postgres:16`. It runs `pg_dump | openssl enc` and uploads to the bucket with a dated name.
   - Its database credential is a read-only role created for backups.
   - The passphrase lives only in the job's sealed Railway variable.
   - Retention: 30 daily copies plus 12 monthly copies.
   - After each upload it re-downloads, decrypts and `pg_restore -l` checks the copy, and sends a failure to the critical-alert channel (R14).
3. **Monthly restore rehearsal:** the same procedure as above, into a temporary database, with results appended here.

## Recovery objectives

| | Target | Today |
|---|---|---|
| RPO (data loss) | 24 h | since the last manual backup (up to days) |
| RTO (time to restore) | 1 h | restore itself takes seconds; total depends on operator availability |

## Recovery procedures

**A. Bad application release (most likely).**
1. Run `scripts/release/verify-lineage.sh` against the previous `prod-*` tag.
2. Deploy that tag with `railway up --detach` to `backend-production` and `worker-production`, and set `APP_COMMIT_SHA`.
3. Migrations are additive, so no schema rollback is needed.

**B. CRM Workforce misbehaving.** Use the least invasive step that works:
1. stop the rooftop or department in the Command Center;
2. use the group emergency stop;
3. set `CRM_WORKFORCE_EMERGENCY_STOP=true`;
4. set the `crmWorkforce` flag off.

**C. Data loss or corruption.**
1. Take a fresh encrypted backup of the current state first.
2. Restore the chosen backup into a **new** database. Never overwrite the live one.
3. Verify counts, then point a temporary API at it and sign in.
4. Only then switch `DATABASE_URL` in a maintenance window.
5. Consent, suppression and audit tables are restored together with leads, so opt-outs keep working.

**D. Encrypted-format forward recovery.**
- Since R3, the CRM Workforce vault writes `v2.<key id>` values. Releases before R3 cannot read them.
- If a rollback past R3 is ever needed after customer data exists, roll forward instead: redeploy R3 or later.
- If a key was lost, restore the backup and the key together. Data sealed with a lost key cannot be recovered; that is the purpose of K1 and K2.
- Production held **0** sealed values at R3, so today every key change is free.

## Encryption keys

| Key | Purpose | Where | Status |
|---|---|---|---|
| `CRM_WORKFORCE_DATA_KEY` | seals customer contact fields | Railway variables (API + worker) | **not set**: falls back to `INTEGRATION_ENCRYPTION_KEY` |
| `CRM_WORKFORCE_HASH_KEY` | lookup hashes (suppression) | Railway variables | **not set**: hashes use the sealing key |
| `CRM_WORKFORCE_DATA_KEY_PREVIOUS` | retired sealing keys, open-only | Railway variables | empty |
| Backup passphrase | backup encryption | owner's machine only | see K1 |

**K2 — switch to dedicated keys now, while production holds no sealed customer data.** Proposed as a Release 4 setting:
1. Set `CRM_WORKFORCE_HASH_KEY` as a Railway *reference* to the existing `INTEGRATION_ENCRYPTION_KEY`, so any existing hash stays identical and no secret is copied by hand.
2. Generate a new 48-byte random `CRM_WORKFORCE_DATA_KEY` directly into Railway; it is never displayed.
3. Run `GET /privacy/key-status` as platform operator to confirm nothing needs re-sealing.

**Later rotations** follow the procedure in `src/crm-workforce/key-rotation.service.ts`:
1. Pin the hash key.
2. Set the new data key, and move the old one into `CRM_WORKFORCE_DATA_KEY_PREVIOUS`.
3. Run `POST /privacy/rotate-keys` until `remaining` is 0.
4. Remove the old key.

Opt-outs never break, because the hashes do not change.
