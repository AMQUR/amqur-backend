# Release gate review — 2026-11-06 (America/Chicago)

Supersedes stale October 18 runtime claims. Public dealership activation was **not** authorized by this work.

## Candidate

| Item | Value |
|---|---|
| Backend PR | https://github.com/AMQUR/amqur-backend/pull/33 |
| Backend branch | `cursor/phase1-integrated-release-4b87` |
| Tip SHA | `3b29c5ceb9a579141fdea5bf04bd7184c108c6fe` |
| Staging generative canary (verified) | `54168cb0a6b1bcef155991a5926a6f443f04eab4` — 150/0, 26 model turns, all 5 tenants |
| Staging tip pin | `3b29c5c` (request-id 404 fallback; Railway staging-only) |
| Staging widget SHA (verified) | `abfb1e2db94b18879d1dc4fc422f7e22027ddb67` |
| Production API SHA (verified) | `1ff54206573eced6d9cdfb85ca8884010e29b004` |
| Production widget SHA (verified) | `2b3a4b47b36cd308777ba150bb6773ec16731d82` |

Production was already deployed externally on 2026-10-18 (Deploy run `39097551581`). This task did not approve that deployment.

## Fixes in this review cycle

1. **LLM spend-gate Redis binding** — `this.cache.isRedisHealthy()` (already on staging `72e5779`).
2. **Response header lifecycle** — RequestIdInterceptor / GlobalExceptionFilter refuse post-send header/body writes (`ERR_HTTP_HEADERS_SENT`).
3. **Strict generative canary** — requires `EXPECTED_COMMIT_SHA`, per-tenant accepted model replies (`polished|answered|composed|repaired`), SHA before/after, refuses production hosts.
4. **CI** — e2e log tee + fail on headers-sent; canary self-tests.

## Gate status (evidence-based)

| Gate | Status | Evidence |
|---|---|---|
| Staging model generation | See canary run appended after execution | Must show ≥1 accepted LM reply **per** of 5 tenants |
| Header regressions | CODE PRESENT → unit tests | CI e2e log scan pending green run |
| Backup restore | **BLOCKED** | Railway MCP has no backup inventory/restore APIs; Hobby plan historically `maxBackupsCount=0`; no restore receipt today |
| Error alert delivery | **BLOCKED** | `ERROR_MONITORING_DSN` **absent** on staging `api` and production `prod-api` variable name lists |
| Exact-SHA CI | Pending on tip after this commit | PR #33 |
| Public activation | **NOT AUTHORIZED** | Feature flags remain fail-closed |

## Owner actions (smallest)

1. Set `ERROR_MONITORING_DSN` privately on staging+prod api/worker via Railway; then authorize a non-sensitive synthetic event and confirm alert delivery receipt.
2. Enable Postgres backups (paid plan if required) and authorize an isolated non-production restore drill; record backup ID + RPO/RTO.
3. Do not enable public dealership traffic until gates 1–2 plus written activation approval.

## Rollback

- Staging: Railway redeploy previous SUCCESS deployment for `api` / `worker` / `widget`.
- Production: previous SHA `1ff5420…` is the current production tip; do not assumption-rollback without an active incident.
