# Release governance — AMQUR backend

**As of 2026-11-25.** This file replaces guesswork about "what is production". It records what was actually deployed, the risk in the current setup, and the reviewed path from here.

## What production actually runs

| Tag (pushed) | Commit | What it is |
|---|---|---|
| `prod-2026-11-25-baseline` | `2d06fe2` | Production before CRM Workforce: the tip of `integration/amqur-unified-sandbox` (Concierge sales journey, ADF delivery, structured cards) |
| `prod-2026-11-25-crmwf-r1` | `0b8e7e3` | CRM Workforce R1 |
| `prod-2026-11-25-crmwf-r2` | `a08e49e` | R2: administration |
| `prod-2026-11-25-crmwf-r3` | `89e598d` | R3: key rotation, evaluation set, contracts; **currently live** |

The production services are `backend-production` and `worker-production` in Railway project `amqur-platform-staging`, environment `production`, database `Postgres-1bjE`. Each was deployed with `railway up` from a detached checkout of the commit above, with `APP_COMMIT_SHA` / `APP_RELEASE_ID` set so that `/api/version` reports exactly what runs.

## Lineage

```
main (cdc9a66)
  └─ integration/amqur-unified-sandbox (+154 commits) = 2d06fe2   ← PR AMQUR/amqur-backend#55 → main (open)
       └─ feat/crm-workforce (+19 to R3, more since)             ← PR AMQUR/amqur-backend#56 → integration (draft)
```

`main` is **behind production by 173+ commits**. Production does not run `main`.

## The risk this creates

- `.github/workflows/deploy.yml` deploys `main` on every push. It goes to staging, then to production once an `AMQUR` reviewer approves in the GitHub `production` environment. Its last five runs (18 Nov) all failed, and it targets services named `prod-api` / `prod-worker`, not the `backend-production` / `worker-production` services that serve AMQUR today.
- Even so, if that workflow were repaired and approved as things stand, it would deploy `main`. That would remove the Concierge sales journey, ADF delivery and CRM Workforce from production; the database tables would stay, with nothing reading them.
- `main` has no branch protection.

## Guard

`scripts/release/verify-lineage.sh <candidate>` reads the commit production reports and refuses any candidate that does not contain it. It also refuses a dirty tree or an unpushed commit. It is read-only. Run it before every deploy.

```bash
scripts/release/verify-lineage.sh 670992c   # OK: contains production 89e598d
scripts/release/verify-lineage.sh origin/main   # REFUSED: would remove live functionality
```

## The reviewed release path (requires approval G1–G3 in the approval register)

1. **G1. Merge PR #56 into `integration/amqur-unified-sandbox`** after review. The integration branch then equals the production lineage. No deploy is triggered: `deploy.yml` listens only to `main`.
2. **G2. Review and merge PR #55 (`integration` → `main`)** with the CRM Workforce commits included. This is not "blindly merging sandbox code". The 154 integration commits are what production has run since before 25 November, and #55 is their review. Merge it **only after G3**, because a push to `main` starts `deploy.yml`.
3. **G3. Correct `deploy.yml` before the merge to `main`:**
   - point it at `backend-production` / `worker-production` in `amqur-platform-staging`;
   - add the lineage guard as a required step;
   - keep the `production` environment reviewer gate;
   - add `migrate deploy` ordering (the API runs migrations on start, as now).

   Then protect `main`: pull request required, CI required, no force-push.
4. After G1–G3, every release is a pull request to `main`, the reviewed workflow deploys it, and a `prod-<date>-<name>` tag records it. The manual `railway up` path becomes break-glass only, and still runs the lineage guard.

Until G1–G3 are approved, releases continue as before: a manual deploy of a reviewed, CI-green, tagged commit that passes the lineage guard, with approval recorded in the approval register.

## Migration discipline

- Migrations are additive: new tables and indexes only. No existing table has been altered by CRM Workforce (R1 `20261125090000`, R2 `20261126090000`, R4 `20261127090000`).
- An encrypted, fully verified backup is taken before every release that carries a migration.
- The schema is never rolled back. Application rollback redeploys an earlier tag; new tables are left unused.
