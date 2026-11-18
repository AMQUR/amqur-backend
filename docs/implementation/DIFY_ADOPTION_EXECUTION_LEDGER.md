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

## Milestones (updated 2026-11-18)
Status scale: coded / tested / CI-green / merged / staging-verified / prod-code-deployed / customer-activated / blocked.
| Phase | Scope | Status | PR / commit | Evidence |
|---|---|---|---|---|
| 0 | Workflow preview (staff-only, read-only) + rooftop-in-tenant check | CI-green, **merged to main** | #39 merge `c9a6ad6` | all 6 CI jobs green on head `5b047c0` |
| 1a | Flag-gated hybrid semantic retrieval, embedding service, staff reindex endpoint | CI-green, **merged** (flags OFF) | #40 merge `ecadbb1` | all 6 CI jobs green on head `43d884b`; never run against the real OpenAI API |
| 1b | Optional guarded pgvector column + ANN candidates | CI-green, **merged** (flag OFF) | #40 | real-DB verified on disposable `pgvector/pgvector:pg16` (ordering, no drafts, no cross-tenant); migration is a no-op on plain `postgres:16`. NOT verified on Railway Postgres |
| 1c | Retrieval eval (synthetic fixture) + injection corpus | tested, merged | #40 | synthetic fixture only; not a real-world accuracy measure |
| 1d | File/URL ingestion hardening, reranker, conflict detection, source inspector | not started | — | existing website ingestion is allowlist + SSRF guarded (reviewed, not extended) |
| 2a | Persisted definitions, immutable versions, review/publish/rollback (SoD, checksum-bound approval, conditional claim, atomic contributor tracking) | CI-green, **merged** | #41 merge `44754f4` (head `7c2f9e4`) | 3 automated security reviews, all findings fixed; migrations `20261118070000`, `…071000`, `…072000` |
| 2b | Persisted SIMULATION runs, human-review suspension, expiry/denial/cancel fail-closed, idempotency, quota | **CI-green on head `1a3559f`** (all 6 jobs, run on that head), NOT merged (merge attempt was blocked by the tool permission classifier; awaiting owner) | #42 (`4fa18e5` + reviewer commits `4a2d517`..`218c980` + `1a3559f`) | migration `20261118080000_workflow_runs`; HTTP e2e suite `test/suites/workflow-lab.e2e-spec.ts` (19 tests: 401/403, cross-tenant 404, cross-rooftop 403, approve-vs-cancel and double-approve races, expiry, idempotency, read-only) stable over 4 consecutive runs on the docker test stack |
| 3a | Workflow Studio UI (catalog, editor, validation, diff, dry run, versions, review, runs) | coded; locally verified; CI pending; stacked on #42 | #43 | vitest 12 pass; Playwright desktop 3/3 + Pixel 7 3/3 on local docker stack against built API; screenshot `docs/implementation/evidence/workflow-studio-chromium.png`; CI does not run Playwright |
| 4 | Tool registry, approvals | not started | — | |
| 5 | Prompt/eval lab, agents, widget | not started | — | |
| 6 | Pilot readiness | not started | — | |

Deployment: merges to `main` triggered the Deploy workflow; `deploy-staging` **failed** on all three ("Sync BLOCKED for staging: could not read Railway variables") before any build or migration. Staging and production unchanged. No production deployment performed. All new flags default OFF.

## BLOCKED_EXTERNAL
- pgvector extension availability + privileges on Railway staging/prod Postgres (migration is a safe no-op if absent). Need: owner to confirm `CREATE EXTENSION vector` is permitted, or run `SELECT * FROM pg_available_extensions WHERE name='vector'` on staging.\n- Embedding provider key: `OPENAI_API_KEY` must be set server-side in staging by the owner (never in chat) + `KNOWLEDGE_EMBEDDINGS_ENABLED=true`.\n- Merge/deploy of #39/#40/#41: no branch protection on `main` (API 404), but no reviewer has approved; I did not self-merge or deploy. Awaiting owner review/go-ahead.\nOther expected: pgvector extension availability on staging/prod Postgres; embedding provider key (name TBD, never value); Tekion API contract.

## Rollback
PR #39 is additive (new module + `app.module.ts` import + composer logging change). Revert = revert PR; no migrations.
