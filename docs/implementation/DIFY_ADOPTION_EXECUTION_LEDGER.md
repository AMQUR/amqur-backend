# Dify-Inspired Adoption — Execution Ledger

Status vocabulary: Existing / Improved / Implemented / Tested / Staging / Production / Blocked.
Nothing below is marked complete without a receipt.

## Verified baseline (2026-11-17/18)
- Repo: `AMQUR/amqur-backend`, PR #39 (draft), branch `feature/workflow-lab-foundation-20261117`.
- Prior head `0e9395a`: CI `build-test` FAILED — lint: `prettier/prettier` errors at
  `src/workflow-lab/workflow-preview.service.spec.ts:29-30` (job log, run 44243364168).
  Other jobs at that time: migrations-empty-db, docker-build, command-center, sbom = SUCCESS; e2e-postgres in progress.
- Fix commit `4806c61` (prettier only) pushed. CI re-run result: **pending — not yet verified**.
- Local receipts on `4806c61` (node_modules symlinked from sibling checkout):
  `npx prettier --write src/workflow-lab` ok; `npm run lint` 0 errors (1 pre-existing warning, auth.service.ts:63);
  `npx tsc --noEmit` clean; `npx jest src/workflow-lab --runInBand` 3 suites / 12 tests pass.
  Full unit + e2e suites NOT run locally.
- Dify archive (`dify-main.zip`) not present in workspace; coverage matrix is source-derived/brief-derived.

## PR #39 safety review (code inspection + unit tests)
| Check | Result | Evidence |
|---|---|---|
| Staff-only | Yes: `@Roles('SUPER_ADMIN','ADMIN','MANAGER')`; global `JwtAuthGuard`+`RolesGuard` APP_GUARDs | controller.ts, app.module.ts:131-132; spec rejects `widget` and `STAFF` |
| Read-only | Yes: no Prisma/HTTP/exec in `src/workflow-lab/*` non-spec; node set = start, knowledge_search, branch, human_review, end | grep receipt |
| Tenant from trusted JWT | Yes: `resolveTenantId(user)` | controller.ts |
| Rooftop isolation | Location-bound MANAGER denied other rooftop (403) | controller spec |
| Customer-visibility | `forWidget: true` ⇒ published, customer-visible only | service.ts |
| Bounds | max 24 nodes, id regex, exact-key validation, acyclic, step budget, 10 req/min throttle | workflow-graph.ts |
| Known gap | Unbound ADMIN-level `locationId` is not validated against tenant (harmless: retrieval is tenant-filtered, yields nothing) — add explicit check in Phase 2 | — |
| Known gap | No e2e test of 401 (unauthenticated) through real guards | add in Phase 2 |

## Milestones (updated 2026-11-18 ~05:50Z)
Status scale: coded / tested / CI-green / staging-verified / prod-code-deployed / customer-activated / blocked.
| Phase | Scope | Status | PR / head | Evidence |
|---|---|---|---|---|
| 0 | PR #39 CI + authz | build-test CI-green (2 runs); e2e-postgres still running at last check; NOT merged | #39 `a1f071f` | prettier fix `4806c61`; rooftop-must-belong-to-tenant check + read-only/injection/oversize tests `a1f071f`; local jest 16 lab tests pass |
| 1a | Hybrid semantic retrieval + embedding service + reindex endpoint | coded+tested locally; CI in progress | #40 `43d884b` | 117 suites/795 tests pass (+2 skipped real-DB), lint 0 errors; flags OFF (`KNOWLEDGE_EMBEDDINGS_ENABLED`) |
| 1b | Optional pgvector column + ANN candidates | coded; **real-DB verified on disposable `pgvector/pgvector:pg16`** (nearest ordering, no drafts, no cross-tenant); migration verified as no-op on plain `postgres:16` | #40 `43d884b` | NOT verified on Railway staging/prod Postgres (BLOCKED_EXTERNAL: extension availability) |
| 1c | Retrieval eval (synthetic fixture) + injection corpus | tested | #40 | synthetic only; not real-world accuracy |
| 1d | File/URL ingestion hardening, reranker, conflict detection, source inspector | not started | — | existing website ingestion already allowlist+SSRF-guarded (reviewed, not extended) |
| 2a | Definitions, immutable versions, review/publish/rollback | coded+tested; real-DB lifecycle test passes; CI in progress. Automated security review found 3 MEDIUM issues (last-editor SoD, approve TOCTOU, rollback bypassing review) — all fixed in `c8c37ec` (checksum-bound approval, conditional claim, rollback = review request) | #41 `c8c37ec` (stacked on #39) | 118 suites/816 tests pass (1 real-DB skipped w/o env; passes with TEST_DB_URL); migrations `20261118070000`, `20261118071000` |
| 2b | Run/step persistence, human-review suspension, async runtime | not started | — | |
| 3 | Workflow Studio UI | not started | — | |
| 4 | Tool registry, approvals | not started | — | |
| 5 | Prompt/eval lab, agents, widget | not started | — | |
| 6 | Pilot readiness | not started | — | |

No production deployment performed. No merges performed. Production traffic unchanged. All new flags default OFF.

## BLOCKED_EXTERNAL
- pgvector extension availability + privileges on Railway staging/prod Postgres (migration is a safe no-op if absent). Need: owner to confirm `CREATE EXTENSION vector` is permitted, or run `SELECT * FROM pg_available_extensions WHERE name='vector'` on staging.\n- Embedding provider key: `OPENAI_API_KEY` must be set server-side in staging by the owner (never in chat) + `KNOWLEDGE_EMBEDDINGS_ENABLED=true`.\n- Merge/deploy of #39/#40/#41: no branch protection on `main` (API 404), but no reviewer has approved; I did not self-merge or deploy. Awaiting owner review/go-ahead.\nOther expected: pgvector extension availability on staging/prod Postgres; embedding provider key (name TBD, never value); Tekion API contract.

## Rollback
PR #39 is additive (new module + `app.module.ts` import + composer logging change). Revert = revert PR; no migrations.
