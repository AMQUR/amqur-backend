# Railway ↔ GitHub Actions — Deployment Credential Recovery

**Scope:** `AMQUR/amqur-backend` GitHub Actions workflow `.github/workflows/deploy.yml` → Railway project `dial-us-now-platform`, staging API/worker. This is an owner/operator runbook, **not authorization to bypass the protected deployment workflow**.

## Symptoms and verified facts

- Since the November 18 feature merges, GitHub's staging deploy attempts have been reported failing **before build/migration**, at `Sync missing worker boot vars from staging/api`, with `Sync BLOCKED for staging: could not read Railway variables; values not printed`.
- This is a **generic error category**: the script wraps Railway CLI execution and JSON parsing in the same catch block. Do **not** claim a token expiration without checking the failed job log and the token's effective permission.
- Verified Railway staging services: `api`, `worker`, `widget`, PostgreSQL, Redis. Last successful `api` and `worker` deployments at reconciliation are from **November 7, 2026**. They do not run workflow Phase 0–3a merged code.
- Railway OAuth access from a separate connection proves only that this session can read variable **names**; it does not test the `RAILWAY_API_TOKEN` secret stored in GitHub Actions.
- Both `api` and `worker` list `CORS_ORIGINS` and `INTEGRATION_ENCRYPTION_KEY` by name. Their values and equality cannot be inspected from that OAuth read.

## Recovery procedure — owner

1. In [AMQUR backend Actions](https://github.com/AMQUR/amqur-backend/actions/workflows/deploy.yml), open the latest **Deploy** run for merge `e61f5f0`. Read `deploy-staging` → `Sync missing worker boot vars from staging/api`; check preceding `Guard — token present` and `Install Railway CLI`. The generic sync error alone does not identify which Railway CLI operation failed.
2. In [Railway API tokens](https://railway.com/account/tokens), verify that the token intended for GitHub automation is an **account or workspace token** with permission to access the `dial-us-now-platform` project and its staging and production environments. **A project token is not interchangeable with `RAILWAY_API_TOKEN`** in this workflow.
3. Create/rotate an appropriate least-privilege token if the old one cannot be validated. Use the Railway UI and paste it **directly into GitHub Secrets**, never in chat, code, shell command history, CI output, or a file in the repository.
4. Open [repository Actions secrets](https://github.com/AMQUR/amqur-backend/settings/secrets/actions). Update the existing secret named `RAILWAY_API_TOKEN`. Also inspect the GitHub `staging` and `production` **environment-level secrets**: an environment secret of the same name can override the repository value. Correct the actual effective secret and its scope; do not create a differently named secret.
5. Confirm GitHub's **`production` environment requires reviewers**. Production must remain gated and must not auto-deploy when staging succeeds.
6. From the existing **Deploy** GitHub Actions workflow, use `Run workflow` on `main` (or re-run the failed job only after confirming it targets the exact intended head). Do **not** manually deploy to Railway or silently switch the services' pinned Git source branches to circumvent a GitHub Actions credential failure.
7. Observe each existing step: `Guard` → `Sync` → `Preflight` → `Publish provenance/deploy api and worker` → `Staging smoke` → `Staging acceptance`. Only claim staging success when the GitHub job and Railway services both show terminal SUCCESS and the staging release identity matches the intended SHA.

## If the token replacement does not resolve the problem

- **Secret absent:** Guard step fails before Railway CLI. Check repo-vs-environment secret name, scope and organization policies.
- **CLI auth/permission:** Using an authorized, secure local shell with an environment variable already loaded (do not echo it), validate Railway CLI authentication and check project/environment/service visibility. Avoid `set -x`, logging environment variables, or piping the JSON variable values to logs.
- **Project/environment/service mismatch:** Check project ID `3bca40b6-01c6-4f02-9464-8682e6ffcb75`; staging expects services `api` and `worker`; production expects `prod-api` and `prod-worker`. Check active Railway project membership.
- **CLI JSON or compatibility issue:** Inspect Railway CLI version and test output shape privately. The sync script parses `railway variables --json`; it suppresses the original failure. Introduce a classified **nonsecret** diagnostic test in a PR if necessary (authentication vs authorization vs malformed output vs network), but do not print raw stderr if it may contain credentials or variable values.
- **Source has missing/invalid cryptographic variable:** After authentication works, the script will report a named missing/invalid key. Resolve it in the Railway UI; do not replace an existing `INTEGRATION_ENCRYPTION_KEY` blindly because doing so can make already encrypted integration data unreadable.

## Deployment success gates

- **Exact release SHA:** Staging API reports the intended `main` SHA, not an earlier release.
- **Schema:** Prisma migrations applied to staging only; no drift, destructive reset, or implicit `CREATE EXTENSION`.
- **Service availability:** Staging `api` and `worker` both terminal SUCCESS, health checks show PostgreSQL/Redis availability.
- **Five rooftop contract:** Widget configuration and tenant routing per rooftop; unauthorized origins denied; staff and widget roles segregated.
- **Simulation isolation:** Workflow lab requires staff roles; published customer-visible knowledge only; cross-tenant, cross-rooftop and unauthorized tests fail closed. New workflow tool/CRM writes remain disabled.
- **pgvector/embeddings:** Keep retrieval flags OFF unless extension availability and staged evaluation are verified. Do not log embedding/model API keys or use real dealership PII for tests.
- **Production:** Separate owner/reviewer authorization, release notes, known-good snapshot, monitoring, rollback and smoke tests before activating any tenant feature.

## Known-good staging rollback anchors (read-only inventory)

- Staging API deployment ID: `4c3b4a55-1f3f-4a13-9fed-7c7f5b1f8171` (SUCCESS, November 7, 2026).
- Staging worker deployment ID: `7383328d-0ae3-4f84-a3cd-8511a8809158` (SUCCESS, November 7, 2026).

Re-verify these IDs are still the known-good releases **immediately before any rollback**. If staging migration introduces new tables, a code rollback may leave additive tables in place; do not drop them without a separate database rollback plan. Production has its own independent rollback anchors.
