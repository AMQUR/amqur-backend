# Release evidence — CRM Workforce R1, 2026-11-25

Redacted: no credentials, no customer data.

## What was released

| | |
|---|---|
| Commit | `0b8e7e3f0cc9a4b5c4a7d4d66544e4e2b1c970ce` (branch `feat/crm-workforce`, PR AMQUR/amqur-backend#56, still draft, not merged) |
| Railway project / environment | `amqur-platform-staging` (e4d54510…) / `production` |
| API | `backend-production`, deployment `71b12ab5-8f46-4653-ad2a-3d45013a9f5d`, 2026-11-25 11:19 CST |
| Worker | `worker-production`, deployment `1896b52d-575b-405b-aa67-9e5b38f5e1f9`, 2026-11-25 11:23 CST |
| Database | `Postgres-1bjE` (host `postgres-1bje.railway.internal`, database `railway`) — confirmed as the database both services use |
| Migration | `20261125090000_crm_workforce`: finished, applied once, 15 tables, 0 failed or pending migrations, new tables empty |
| Previous release (rollback target) | `2d06fe26496262421d469ae266d7d54d6b7ad046` |
| Path | Manual `railway up` from the `amqur-backend-deploy-prod` worktree, the same path as previous releases. Nothing merged to `main`; `deploy.yml` not triggered |

Not released to: the older `dial-us-now-platform` project (api.dialusnow.com, still on `1ff5420`). Untouched.

## Backup and restore (R5)

| Check | Result |
|---|---|
| Method | `pg_dump` (custom format) inside the production Postgres container, encrypted with AES-256-CBC (PBKDF2, 200,000 iterations) before it was written |
| Location | `/var/lib/postgresql/data/amqur-backups/amqur-prod-pre-crmwf-20261125.dump.enc` on the production database volume, directory mode 700 |
| Size / SHA-256 | 275,120 bytes / `8163c1ed85d58637a4a3372f5b09196a5ea2961f3e5fbc1545abd2bf516f713f` |
| Key | Passphrase file on the owner's workstation, `.local-secrets/prod-db-backup-20261125.key` (gitignored, mode 600). **Only copy — move it into the password vault.** |
| Integrity | Decrypts; table of contents lists 55 tables of data |
| Restore rehearsal | Full restore into a separate throwaway database on the same server in 1 s; 55/55 tables; every table's row count identical to production |
| Migration on restored copy | Applied cleanly in one transaction; 15 new tables; existing tables' row counts unchanged |
| Clean-up | Throwaway database dropped; only `postgres` and `railway` remain |
| Retention | Kept until deleted by an operator. Recommended: delete after 30 days once a native Railway backup schedule exists |
| Limitation | The copy sits on the same volume as the database it protects. It covers a bad migration or bad data, not loss of the volume. Add a native Railway backup schedule on `Postgres-1bjE` (Backups tab in project amqur-platform-staging, environment production) |
| Note | A native backup was also taken on 2026-11-25 11:16 of `Postgres-RfDb` in project `dial-us-now-platform`. That is the older stack's database, not the one AMQUR production uses |

## Staging rehearsal

`backend-staging` and `worker-staging` on `0b8e7e3`. Migration applied once. 33/33 functional checks passed:

- staff login works, and anonymous calls are refused
- the engine is off, the send switch is off, and both Tekion connectors are blocked
- the employee-assisted flow works end to end (enter → draft → record send → continue)
- an opt-out produces no draft
- appointment requests stay requests, and follow-up items are created
- takeover and return both work
- a real-data import is refused
- Chevy cannot see or act on Nissan records
- no phone or email appears in API output
- the rooftop stop blocks drafting, and resume works
- the roster, reports and audit ledger work, and the audit holds no contact details
- the Command Center serves the new screens

Two defects were found and fixed before production: the drafting guard refused the reply to "Is the Rogue still available?"; the first fix was then too permissive and was tightened after a security review. CI is green on all six jobs for `0b8e7e3`.

## Production verification after release

| Check | Before | After |
|---|---|---|
| `/api/version` | 2d06fe2 | 0b8e7e3 |
| `/api/health` | ready; database up, Redis up, model configured | same |
| Worker | running | running; `CrmWorkforceModule` loaded; engine not started (switch unset); 0 error lines |
| CRM Workforce API without a login | n/a | 401 |
| Command Center `/cc/` | 200 | 200; bundle contains the CRM Workforce screens |
| Concierge, one question per tenant (5 rooftops + group) | Nissan 2.3 s to first text | all six answered; Nissan 1.3–1.5 s on repeat |
| Widget chat token from each site's own origin (dialchevy, dialnissan, infinitichicago, dialjeep, jeepofchicago, dialdifference, dialautogroup) | — | 7/7 issued |
| `crmWorkforce` flag | — | unset on all 6 tenants and all locations |
| `CRM_WORKFORCE_*` env switches | unset | unset |

Not verified in production: signed-in use of the CRM Workforce screens. **Production has no active staff accounts in any tenant**, so no one can sign in to the Command Center. This predates the release.

## Rollback

1. Stop the module only: unset nothing (it is already off). If needed, `CRM_WORKFORCE_EMERGENCY_STOP=true` on `backend-production` and `worker-production`.
2. Code: in `amqur-backend-deploy-prod`, `git checkout --detach 2d06fe2` and `railway up --service backend-production --environment production`, then the same for `worker-production`. Or Railway → Deployments → Redeploy the previous deployment (`65591fc1…` API, `81666bce…` worker).
3. Database: none. The 15 new tables are empty and nothing else reads them. Never restore over production.
