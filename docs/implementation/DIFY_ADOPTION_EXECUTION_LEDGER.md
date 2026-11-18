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
| 2b | Persisted SIMULATION runs, human-review suspension, expiry/denial/cancel fail-closed, idempotency, quota | CI-green, **merged to main**, staging not deployed | #42 merge `4227ee9` (head `1a3559f`) | All 6 CI jobs green; real-JWT/Postgres/Redis e2e security suite (19 scenarios), cancellation/review races, one audit record; new workflow tables not deployed to staging |
| 3a | Workflow Studio UI (catalog, editor, validation, diff, dry run, versions, review, runs) | Code completed for Phase 3a, CI-green, **merged to main**, staging not deployed | #43 merge `e61f5f0` (head `f06e362`) |  All 6 GitHub CI jobs pass; local Playwright desktop 3/3 and Pixel 7 3/3 (not run in CI); missing drag-connect, node rename, trace export, screen-reader audit, mobile screenshots |
| 4a | Typed tool catalog (3 write tools, MOCK providers), approval inbox API, consent/role policy, checksum-bound independent approval, idempotency, outbox dispatch to mock executor | merged to main 2773cc2 via #44 (CI 6/6 green: unit, e2e-postgres, migrations-empty-db, docker, command-center, sbom); Staging Deploy for this merge not verified; later merges failed at Railway variable read; nothing in production | #44 | migration `20261118090000_tool_action_requests`; flags `TOOL_REGISTRY_ENABLED` and `TOOL_DISPATCH_ENABLED` both OFF; no real provider exists. Delivered later: Command Center inbox UI (#47), workflow tool node (#48), consent-record linkage (#49). Still missing: real providers |
| 4b | Command Center "Action approvals" inbox (status filters, tool/risk/redacted input, consent ref, checksum-bound approve/deny, requester cancel, flag/mock banners) | coded; UI helper unit tests (6) + tsc + vite build pass locally; merged to main 8a08eda via #47 (CI green); Deploy → staging failed at the Railway variable-read step (root cause not verified) ("could not read Railway variables"); staging/production unchanged; not browser-verified against a live backend | branch `feature/tool-approvals-inbox-20261118` | UI only, no backend change; nav entry for SUPER_ADMIN/ADMIN/MANAGER; server remains the authority on every rule. Delivered separately: workflow tool node (#48) and consent-record linkage (#49). Still missing: proposing from the UI, Playwright coverage, real providers |
| 4b-wf | Workflow `tool_action` node: proposal-only into the approval inbox, consent-free catalog tools only, static validated fields, runs as the starter with key `wfrun-<runId>-<nodeId>`, skipped when registry is OFF, preview shows `would_propose`; Studio editor support | coded; unit 888 total pass, HTTP e2e 4 new (workflow+tool suites 33 pass), UI tests 21 pass, tsc/eslint/build clean; merged to main e2286bb via #48 (CI green after PII-hardening fix); Deploy → staging failed at the Railway variable-read step (root cause not verified) ("could not read Railway variables"); staging/production unchanged | branch `feature/workflow-tool-node-20261118` | no schema change; flags stay OFF. Limits: fields are static (runs carry no lead id or customer text into actions), run does not wait for the approval decision, consent-required tools (appointment.request, message.send) intentionally unavailable, no real provider. Not browser-verified |
| 4c | Consent linkage: `consentRef` must be a real, current `ConsentRecord` (same tenant, lead, rooftop, channel, purpose; latest record wins); verified at propose, again at approve (409 if no longer valid; deny always allowed), and again at execute (FAILED + audit `tool.action.blocked.consent`, never executed). Error reasons are codes only | coded; unit 905 total pass (17 new), HTTP e2e 5 new + tool/workflow suites 38 pass x2, eslint/tsc/build clean; merged to main a7dd1da via #49 (CI 6/6 green on head 6a81aee); Deploy → staging failed at the Railway variable-read step (root cause not verified); staging/production unchanged | branch `feature/tool-consent-linkage-20261118` | no schema change; flags stay OFF. Policy: message.send = CONVERSATIONAL, channel must equal input.channel; appointment.request = TRANSACTIONAL, any channel. Limits: consent-required tools still unavailable in workflow nodes (static graphs carry no lead/consent), consent is not captured by this feature (existing messaging ledger is the source), still mock providers, no UI change, staging not exercised |
| 5 | Prompt/eval lab, agents, widget | not started | — | |
| 6 | Pilot readiness | not started | — | |

Deployment: merges to `main` triggered the Deploy workflow; `deploy-staging` **failed** on every merge so far (#39–#43 merges) ("Sync BLOCKED for staging: could not read Railway variables") before any build or migration. Staging and production unchanged. No production deployment performed. All new flags default OFF.

## BLOCKED_EXTERNAL
- pgvector extension availability + privileges on Railway staging/prod Postgres (migration is a safe no-op if absent). Need: owner to confirm `CREATE EXTENSION vector` is permitted, or run `SELECT * FROM pg_available_extensions WHERE name='vector'` on staging.\n- Embedding provider key: `OPENAI_API_KEY` must be set server-side in staging by the owner (never in chat) + `KNOWLEDGE_EMBEDDINGS_ENABLED=true`.\n- Merge/deploy of #39/#40/#41: no branch protection on `main` (API 404), but no reviewer has approved; I did not self-merge or deploy. Awaiting owner review/go-ahead.\nOther expected: pgvector extension availability on staging/prod Postgres; embedding provider key (name TBD, never value); Tekion API contract.

## Rollback
PR #39 is additive (new module + `app.module.ts` import + composer logging change). Revert = revert PR; no migrations.


## 2026-11-18 checked reconciliation (supersedes stale earlier rows where conflicting)

- PRs #39, #40, #41 and #42 **merged to main** (merge commits `c9a6ad6`, `ecadbb1`, `44754f4`, `4227ee9`). This reflects GitHub status verified after the older ledger rows were written.
- Phase 3a PR #43 `feature/workflow-studio-20261118` is **open/draft/mergeable**, head `52c5cb2`; GitHub Actions CI run `44299486199` completed **success**, all six jobs passed. The branch was 1 commit behind `main` when inspected; check/retest its exact target merge result before merging. The UI is not yet accessible on staging/production.
- Railway live API inventory via connected OAuth: project `dial-us-now-platform` (`3bca40b6-01c6-4f02-9464-8682e6ffcb75`), staging environment `e89573c2-55bd-409b-aa03-9c858feefe77`. Staging services `api` and `worker` both list the variable **names** `CORS_ORIGINS` and `INTEGRATION_ENCRYPTION_KEY`; values were withheld, and validity was **not** checked. Their latest observed SUCCESS deployments were dated 2026-11-07, not the new merged commits.
- The GitHub `deploy.yml` staging step runs `node scripts/sync-worker-required-from-api.mjs staging` with the GitHub Actions repository secret `RAILWAY_API_TOKEN`. The script catches authentication/CLI/JSON parsing errors and emits the generic error `could not read Railway variables`; therefore **root cause not proven**. Connected Railway OAuth is valid but does not establish validity of the GitHub Actions token. Owner must inspect/reissue a workspace/account-scoped token and update `AMQUR/amqur-backend` Actions secret securely, then rerun deployment; do not put token values in GitHub commits, PRs, logs or chats.
- After fixing deployment access: inspect staging migrations against the actual database, verify `pgvector` support and embedding flags (currently OFF), read exact release SHA from staging API, smoke all five rooftop tenants, and require production approval separately. Do not claim staged or production-ready functionality based on merged code alone.
- Remaining engineering work: Phase 1d; Phase 3b drag-to-connect, node rename, trace export, accessibility audit and Playwright-in-CI; Phases 4–6. All customer-facing/write-capable tools remain approval-gated and disabled.


## Phase 4a design record (tool registry and approvals)
- Catalog is code (`src/tool-registry/tool-catalog.ts`): every tool is a WRITE with per-tool proposer/approver roles, risk, consent requirement and exact-key field schema. `message.send` (HIGH) is approvable by ADMIN/SUPER_ADMIN only.
- `ToolActionRequest` is the approval record. Input is stored with free text masked; the approver must submit the `checksum` they reviewed (tool, version, rooftop, redacted input, consent ref), recomputed server-side at decision time.
- Decisions use a conditional `updateMany` (status PENDING_APPROVAL and not expired) inside a transaction that also writes the audit row and, only when `TOOL_DISPATCH_ENABLED=true`, one outbox event keyed `tool-action:<id>`. Deny, cancel, expiry and silence never enqueue.
- Executor (`tool.action.mock`) runs only APPROVED actions, is idempotent on replay, and only ever calls the mock; raw customer text is never persisted, so a real provider phase must add a secure payload path.
- Rooftop-bound managers see and act only on their own rooftop; tenant-wide actions are admin-only. Tenant, role and rooftop come only from the JWT.
- Rollback: revert the PR; the migration only adds a table and enum.
