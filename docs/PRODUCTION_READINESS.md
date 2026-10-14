# Production readiness — traceability

Branch: `feat/production-completion-2026-10` (backend + widget). Verified 2026-10-13 on the disposable local stack (Postgres 16, Redis 7, mock CRM/inventory) — never against production.

Status legend: **Done** = user flow reaches it, record persists, authz enforced, truth semantics correct, error path handled, telemetry, tests, staff surface, gate, docs. **Gated** = done but disabled until an external artifact in `PRODUCTION_BLOCKERS.md`.

## Baseline (before this pass)

| Check | Result |
|---|---|
| Backend unit | 263/263 |
| Backend e2e (Postgres) | 36/36 — **not run in CI** |
| Widget unit | 35/35 |
| Lint | 0 errors (5 warnings) |
| Widget bundle | 624.6 KB raw / 188.5 KB gzip (React development build shipped) |

## Defects found and fixed (selected)

| Defect | Fix | Evidence |
|---|---|---|
| Appointments only in memory; hard-coded Mon–Sat hours; `confirmed:true` on capture | `AppointmentService` lifecycle, `StoreHoursService` (tz/DST/holidays/departments, staff-verified only) | `test/suites/production-domains`, `journeys` |
| Parts reply was static text; no `PartsInquiry` | Parts tool persists inquiry, VIN capture, install linkage | `journeys` parts test |
| No finance path; widget finance action produced nothing | `FinanceRequest` upsert + credit-link lifecycle | `journeys` sales test |
| Three conflicting payment assumptions (9.99%/$899/9.25% chat; 6.99%/$358/9.5% carousel) | Single `FinancialAssumptionPolicy`; illustrative unless dealer-verified | `payment.service.spec`, journeys card assertion |
| Tekion writeback persisted `mock-tekion-lead-*` IDs as `SYNCED` | Fail-closed adapter, capability declaration, `CrmSyncService` gate | `tekion.provider.spec`, ops e2e |
| Outbox claim not atomic; unknown topics marked PUBLISHED | `FOR UPDATE SKIP LOCKED`, DB-clock leases, lease-guarded completion, DLQ | `production-domains` (5 concurrent workers) |
| Lead upsert fire-and-forget | Awaited critical writes; failure → honest "nothing was saved" | orchestrator |
| Inventory query: second `OR` overwrote location filter; SOLD units returned for payment; `holdVehicle` mutated authoritative inventory | Rewritten inventory tool; holds become staff requests | journeys sold/in-transit eval cases |
| Demo imagery (`customer=demo`) replaced real photos; third-party sticker site | Removed; feed photos only | — |
| Widget `confirmationKey` replaced backend outcome with canned "request saved" | Removed; UI renders backend cards only | widget Playwright |
| Widget dropped messages typed during an in-flight reply | Fixed | Playwright journey |
| Saved vehicles readable with any client-chosen key (IDOR) | Signed tenant-bound conversation IDs | `tenant-isolation` |
| Webhook "signature" was `sha256(secret + re-serialized JSON)`; dedupe before verify | HMAC-SHA256 over raw body + timestamp + event id, rotation, verify-first | `security-primitives.spec` |
| Website ingestion followed redirects automatically (SSRF) | Manual redirect validation + DNS private-range rejection | — |
| Retention "archives" actually hard-deleted, on `updatedAt` | Honest hard-delete policy, last-activity, legal hold, audit retained | `data-governance` |
| Knowledge created as STAFF only; widget retrieved APPROVED (unpublished) docs | Full lifecycle; widget retrieves PUBLISHED+CUSTOMER only | `operations` e2e |
| JWT guard accepted any token type | `typ` enforced; MFA challenge tokens rejected | `jwt-auth.guard.spec`, `auth-mfa` |
| React development build in embed | Production build: **251.7 KB / 78.9 KB gzip** | `npm run build` |

## Requirement → code → test

| Requirement | Code | Tests | Status |
|---|---|---|---|
| Appointment lifecycle (request/pending/confirmed/rescheduled/cancelled/completed/no-show, idempotent, tz, provenance) | `src/appointments/*` | `production-domains`, `journeys`, `ai-eval` | Done (confirmation via staff; provider confirmation **Gated B-01**) |
| Store hours single source of truth | `src/locations/store-hours.service.ts`, `common/time/*` | `store-hours.service.spec` (DST, midnight, holidays, "tomorrow", "this Saturday") | Done (values **Gated B-03**) |
| Parts domain | `src/parts/*`, orchestrator `handleParts` | `journeys`, `ai-eval` | Done (provider **Gated B-01**) |
| Finance + credit application | `src/finance/*` | `journeys`, `security-primitives.spec` | Done (destination **Gated B-05**) |
| Payment consistency | `finance/financial-assumption-policy.ts`, `payment.service.ts` | `payment.service.spec`, journeys | Done |
| Truth/provenance on live path | `source-authority/claim-evidence.ts`, orchestrator evidence | journeys evidence assertions, grounding specs | Done |
| LLM routing + breaker | `src/ai/llm-router.service.ts` | `llm-router.service.spec` | Done |
| Multi-intent understanding | `chat/understanding/*` | `turn-understanding.spec` (adversarial words), eval | Done |
| Human-like dialogue style | `chat/dialogue/dialogue-style.ts` | `conversation-style` e2e | Done |
| Multilingual EN/ES | understanding + orchestrator `tr()` + widget copy | journeys Spanish, eval | Done |
| Durable conversation state (multi-replica) | `chat/memory/journey.store.ts` (optimistic concurrency) | all chat e2e | Done |
| Outbox multi-worker safety | `integrations/core/outbox*.ts` | `production-domains` | Done |
| Webhook security | `common/security/webhook-signature.ts`, `messaging/twilio.ts` | `security-primitives.spec`, `messaging` | Done |
| Upload security | `src/uploads/*` | `data-governance` | Done (storage **Gated B-13**) |
| Retention + privacy requests | `observability/retention.service.ts`, `src/privacy/*` | `data-governance` | Done |
| Knowledge publication + hybrid retrieval | `knowledge/knowledge-lifecycle.service.ts`, retrieval | `operations` | Done |
| Saved vehicles sync | widget `useConcierge`, `saved-vehicles` | `tenant-isolation` | Done |
| Tekion capability-ready writeback | `integrations/tekion/*`, `integrations/crm/crm-sync.service.ts` | `tekion.provider.spec`, ops e2e | **Gated B-01** |
| Consent ledger + SMS + campaigns | `src/messaging/*` | `messaging` e2e | **Gated B-07** |
| Staff MFA, logout-all, token typing | `src/auth/*` | `totp.spec`, `jwt-auth.guard.spec`, `auth-mfa` | Done |
| Command Center | `command-center/`, `src/operations/*` | `operations` e2e, Command Center Playwright | Done |
| Widget Concierge Canvas | `amqur-widget/src/widget/concierge/*` | 42 unit, 44 Playwright (5 projects) | Done |
| AI evaluation harness | `test/suites/ai-eval.e2e-spec.ts` | 25/25, 0 severe | Done |
| Config validation fail-closed | `config/env.validation.ts` | `env.validation.spec` | Done |
| CI: Postgres e2e, Command Center build, SBOM | `.github/workflows/ci.yml` | — | Done |

## Final local verification (this pass)

| Suite | Result |
|---|---|
| Backend unit | 336/336 |
| Backend e2e (Postgres/Redis) | 81/81 — two consecutive full runs |
| AI evaluation | 25/25 cases, 0 severe |
| Widget unit | 42/42 |
| Widget Playwright (Chromium, Firefox, WebKit, Pixel 7, iPhone 14) | 44 passed, 16 skipped by design (project-specific) |
| Command Center Playwright | 2/2 |
| Typecheck / lint | clean (0 errors) |
| Production Docker image | builds; contains API, worker, Command Center |
| Migrations | 3 new additive migrations apply cleanly to an existing DB and from empty (CI job) |

## Load (measured locally — not a production capacity claim)

Hardware: Apple M5 Pro (18 cores, 24 GB), single API process, Postgres 16 + Redis 7 in Docker, LLM disabled.

| Profile | Requests | Errors | p95 | p99 | Chat avg |
|---|---|---|---|---|---|
| EXPECTED_PILOT (45 s) | 9,000 | 0 | 30 ms | 33 ms | 22 ms |
| BURST_2X (30 s) | 8,660 | 1,910 — all `widget-token` 429 (deliberate 30/min/IP throttle) | 32 ms | 50 ms | 36 ms, 0 chat failures |

With an LLM enabled, polish adds model latency (bounded 8 s, then deterministic draft).

## Known pre-existing schema drift

`prisma migrate diff` reports drift that predates this work (tenant FK re-creates on Location/User/Vehicle, `updatedAt` defaults, one index rename). New migrations intentionally exclude it; reconcile in a dedicated, reviewed migration.
