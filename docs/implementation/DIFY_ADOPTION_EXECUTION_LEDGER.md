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

## Milestones
| Phase | Scope | Status | Branch/PR | Notes |
|---|---|---|---|---|
| 0 | Baseline + PR #39 CI | Improved; CI re-run pending | PR #39 | see above |
| 1 | Hybrid knowledge (pgvector) | Not started | — | needs migration review of existing Knowledge schema first |
| 2 | Durable workflow core | Not started | — | |
| 3 | Visual Workflow Studio | Not started | — | |
| 4 | Tool registry/approvals | Not started | — | |
| 5 | Prompt/eval lab, agents, widget | Not started | — | |
| 6 | Pilot readiness | Not started | — | |

## BLOCKED_EXTERNAL
None recorded yet. Expected: pgvector extension availability on staging/prod Postgres; embedding provider key (name TBD, never value); Tekion API contract.

## Rollback
PR #39 is additive (new module + `app.module.ts` import + composer logging change). Revert = revert PR; no migrations.
