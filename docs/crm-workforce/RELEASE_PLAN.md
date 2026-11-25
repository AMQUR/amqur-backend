# Production release plan — CRM Workforce (for approval)

**Not executed.** This is the exact plan to approve. Nothing below has been run against production.

## What is released

- Branch `feat/crm-workforce`, pull request AMQUR/amqur-backend#56, based on `2d06fe2` — the commit production reports at `/api/version` on 2026-11-25.
- One migration, `20261125090000_crm_workforce`: creates 15 tables, 6 enums and their indexes. It contains no `ALTER`, `DROP` or data change on any existing table.
- Code: `src/crm-workforce/` plus four one-line touches (module import, two default-off flags, env-gated worker interval), and the Command Center page.

## State after release, before any configuration

| Thing | State |
|---|---|
| `crmWorkforce` flag | off for every tenant |
| `crmWorkforceRealImports` flag | off for every tenant |
| `CRM_WORKFORCE_ENABLED` (engine) | not set → engine does not start |
| `CRM_WORKFORCE_EXTERNAL_SEND_ENABLED` | not set → no system send possible |
| Tekion API / browser connectors | blocked in code |
| Concierge, widget, ADF, inventory | unchanged code paths |

Staff see a new "CRM Workforce" entry in the Command Center that says OFF.

## Path

The repository's `deploy.yml` deploys on push to `main` to a different, older Railway project. Production today is deployed by hand from the detached worktree `amqur-backend-deploy-prod` with `railway up`. This release uses that same manual path; nothing is merged to `main`.

## Steps

1. **Coordinate.** Confirm no other release is in flight (another session deployed `2d06fe2` on 2026-11-25). Confirm `amqur-backend-deploy-prod` is clean.
2. **Record health before.** `GET /api/health`, `GET /api/version`, widget token + one chat turn via `scripts/probe/prod-stream.mjs`, Command Center login. Save outputs.
3. **Backup.** Take a Railway Postgres backup of production and note its id. (Restore drill R5 is still open; this step is the point-in-time safety net for this release only.)
4. **Rehearse on staging.** `railway up` the same commit to `backend-staging` and `worker-staging`; confirm `prisma migrate deploy` applies one migration, health is ready, the concierge suites' smoke passes, and `/cc/#/crm-workforce` shows OFF.
5. **Deploy API.** In `amqur-backend-deploy-prod`: `git fetch && git checkout --detach <sha>`, then `railway up --service backend-production --environment production --ci`. The container runs `prisma migrate deploy` before starting.
6. **Deploy worker.** Same commit to `worker-production`. With `CRM_WORKFORCE_ENABLED` unset it logs nothing new.
7. **Verify after.** Repeat step 2 and compare. Additionally: `prisma migrate status` clean; `/api/ops/crm-workforce/status` as an admin returns `featureFlag:false, processEnabled:false, externalSendEnv:false`; a staff token from one tenant gets 403 on another tenant's id; `/cc/#/crm-workforce` loads.
8. **Stop here.** Pilot configuration (R2) is a separate approval.

## Rollback

| Situation | Action | Data effect |
|---|---|---|
| Anything looks wrong after step 5 | Redeploy `2d06fe2` to backend-production and worker-production (Railway "redeploy previous", or `railway up` from the worktree) | None. The 15 new tables stay, empty; nothing reads them |
| Workforce misbehaves later | `CRM_WORKFORCE_EMERGENCY_STOP=true`, or unset `CRM_WORKFORCE_ENABLED`, or flag off per tenant | None |
| Migration fails to apply | The API container does not start; Railway keeps the previous deployment serving. Fix forward or redeploy `2d06fe2` | None (create-only; a partial apply leaves only new empty tables) |

The schema is never rolled back. Rollback commit: `2d06fe2`.

## Verified so far

- Migration applies cleanly to an empty database and on top of the full existing chain (local, and CI job `migrations-empty-db`).
- Full backend unit and integration suites pass with the module present and off (see pull request).
- Not verified: staging rehearsal (step 4), production backup/restore (R5), behaviour under production load.
