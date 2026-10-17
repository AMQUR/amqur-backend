# Master production execution ledger

Last updated: 2026-10-14 (release reconciliation pass). Branch `feat/production-completion-2026-10` (backend PR AMQUR/amqur-backend#28, widget PR AMQUR/amqur-widget#21). Nothing here is deployed to staging or production by this work.

Statuses: `NOT_IMPLEMENTED` · `IN_PROGRESS` · `CODE_COMPLETE` (built, unit-tested) · `LOCAL_VERIFIED` (proven on the disposable Postgres/Redis stack through the real HTTP API) · `INTEGRATION_VERIFIED` (proven against the real vendor) · `STAGING_VERIFIED` · `PRODUCTION_VERIFIED` · `EXTERNAL_DEPENDENCY_BLOCKED` · `RELEASE_BLOCKED`.

No row is above `LOCAL_VERIFIED`: no vendor integration has credentials, the October build has not been deployed to staging (merge is an owner action; the Railway CLI session is expired), and no production approval exists.

## Customer conversation

| Capability | Status | Module | Evidence | Remaining blocker |
|---|---|---|---|---|
| Natural small talk, greetings, identity honesty | LOCAL_VERIFIED | `chat/dialogue/social.ts`, `turn-understanding.ts` | conversation-acts spec, golden suite, simulator | Live-model polish untested (no API key) |
| Text normalization (slang, typos, voice splits) | LOCAL_VERIFIED | `chat/understanding/normalize.ts` | normalize.spec, simulator | — |
| Multi-intent, references, corrections, department switching | LOCAL_VERIFIED | orchestrator, journey store | golden E, simulator cross-department + 20–50 turn sessions | — |
| Spanish / mixed language | LOCAL_VERIFIED (deterministic) | understanding + `tr()` | simulator, hold-out | Native-speaker review not done |
| LLM language polish with grounding guard | CODE_COMPLETE | `ai/llm-router.service.ts`, grounding guard | router unit tests | EXTERNAL_DEPENDENCY_BLOCKED: no provider key in any environment we can reach |
| Emergency AI off / deterministic-only switch | LOCAL_VERIFIED | `ops/locations/:id/ai-control` | five-rooftop e2e | — |

## Sales

| Capability | Status | Module | Evidence | Remaining blocker |
|---|---|---|---|---|
| Inventory search, filters, carousel (exact result set) | LOCAL_VERIFIED on SIMULATED data | `chat/engines/inventory.engine.ts` | golden, simulator, isolation | Live feed (B-02) |
| Production never serves synthetic inventory/hours | LOCAL_VERIFIED | `InventoryEngine.liveOnly`, capability, hours | golden "invisible to production reads", unit | — |
| Inventory pipeline (XML/CSV/JSON/HTTPS, SSRF guard, anomaly rejection) | CODE_COMPLETE | `inventory-feed/*` | unit (+ CSV prototype-pollution hardening) | SFTP adapter not built; vendor feed authorization (B-02) |
| Compare, ranking ("two nicest") | LOCAL_VERIFIED | orchestrator | golden B | — |
| Payment estimates (single policy, adjustments, targets) | LOCAL_VERIFIED | `financial-assumption-policy.ts`, `payment.service.ts` | independent-oracle checks on every simulated turn | Dealer-verified tax/fee rules (B-06) |
| Out-the-door quote (verified inputs only, else staff request) | LOCAL_VERIFIED (request path) | `finance/otd-quote.ts`, `price-quote.service.ts` | golden D, simulator | Verified tax/fee/government charges per store; Illinois doc-fee cap value needs official confirmation |
| Trade-in appraisal (estimate vs appraisal vs offer, manager approval, expiry) | LOCAL_VERIFIED (human appraisal path) | `trade/appraisal.service.ts` | trade-appraisal e2e | Valuation provider licensing (all candidates NOT_LICENSED) |

## Finance

| Capability | Status | Module | Evidence | Remaining blocker |
|---|---|---|---|---|
| Secure credit-application handoff (encrypted destination, link types, per-store authorization, rotation, preview) | LOCAL_VERIFIED | `finance/credit-*` | golden C/H, isolation (store-bound links, signature splicing) | Tekion link type + per-store written approval (B-05) |
| Click tracking (offered/clicked; completion only from provider) | LOCAL_VERIFIED | `CreditLinkController` | golden, simulator DB invariants | Provider completion callback not available |
| Per-customer link issuance | CODE_COMPLETE (interface only, fails closed) | `CreditLinkProvider` | unit | Official Tekion contract |

## Service and parts

| Capability | Status | Module | Evidence | Remaining blocker |
|---|---|---|---|---|
| Service appointment REQUESTS (tz/DST/holidays, symptoms, own-vehicle separation) | LOCAL_VERIFIED | `appointments/*`, orchestrator | journeys, golden E, simulator | Live scheduler + verified hours (B-01, B-03) |
| Provider-confirmed booking | CODE_COMPLETE (fails closed) | `scheduling-provider.registry.ts` | unit | Tekion scheduling contract |
| Parts inquiry (VIN, fitment never claimed) | LOCAL_VERIFIED | `parts/*` | journeys, simulator | Licensed catalog / Tekion parts |
| RO status | CODE_COMPLETE (fails closed) | orchestrator | ai-eval | Tekion RO contract |

## Integrations

| Capability | Status | Remaining blocker |
|---|---|---|
| Tekion CRM/DMS adapter | CODE_COMPLETE, fails closed; HTTP client intentionally absent | Official Tekion APC spec, sandbox, credentials, dealer/store IDs (B-01) |
| vAuto / normalized feed | CODE_COMPLETE | Feed authorization per store (B-02) |
| Twilio SMS + consent ledger + campaigns | CODE_COMPLETE | Registered sender, A2P, consent wording approval (B-07) |
| Email, WhatsApp, voice | NOT_IMPLEMENTED (adapters) — vendor not chosen | B-08, B-09; WhatsApp Business access |
| Human handoff delivery (CRM webhook) | CODE_COMPLETE | Verified destination (B-04) |

## Staff, management, data

| Capability | Status | Evidence | Remaining blocker |
|---|---|---|---|
| Command Center: inbox, takeover, reply, notes, queues (incl. OTD quotes, trade appraisal/offer), rooftop settings, credit destination, emergency controls | LOCAL_VERIFIED | CC Playwright 2/2, e2e | Staff accounts per store |
| Five-rooftop readiness registry + scorecard (`GET /api/ops/group/readiness`) | LOCAL_VERIFIED | unit + `docs/FIVE_STORE_SCORECARD.md` | Store evidence (see scorecard) |
| Cross-rooftop isolation (inventory, prices, conversations, credit links, admin scope, phones, hours, kill switch) | LOCAL_VERIFIED | five-rooftop-isolation e2e (12) | — |
| Group all-store comparison (`/api/dealer-groups/:id/comparison`, CC Group page) | LOCAL_VERIFIED | five-rooftop e2e (counts = DB counts, non-members 403) | AI cost, sales attribution, SLA timing need a verified source |
| Unified customer view (read-only, exact phone/email, never merges) | LOCAL_VERIFIED | five-rooftop e2e | Staff-approved merge/unmerge workflow NOT_IMPLEMENTED |
| Knowledge lifecycle + hybrid retrieval | CODE_COMPLETE | operations e2e | pgvector availability on Railway unverified (absent locally); embeddings stored as JSON |
| Dealer spotlights (two-person approval, store scope, auto-withdraw when sold) | LOCAL_VERIFIED | spotlights e2e | — |
| Greeting copy experiments (stable assignment, copy rules, z-test, no auto-promote) | LOCAL_VERIFIED | experiments unit + e2e | Other surfaces not yet experimentable |
| Rich media library (walkarounds, video) | NOT_IMPLEMENTED | — | Storage + media authorization (B-13) |
| Privacy export/deletion, retention, legal hold | LOCAL_VERIFIED | data-governance e2e | Counsel review |
| Staff MFA, RBAC, token typing | LOCAL_VERIFIED | auth-mfa e2e | — |

## Quality, security, operations

| Item | Status | Evidence |
|---|---|---|
| Customer simulator (1,670 scenarios / ~5,100 turns per run; P0/P1 gates; DB invariants) | LOCAL_VERIFIED | `test/simulator`, `test/evidence/simulator-latest.json` |
| Independent hold-out phrasings | LOCAL_VERIFIED | first blind run 49/54 (90.7%) recorded; 54/54 after fixes |
| Live-model evaluation | EXTERNAL_DEPENDENCY_BLOCKED | No provider key |
| Dependency vulnerabilities | Criticals 0; runtime highs fixed; see `docs/DEPENDENCY_SECURITY.md` |
| Signature malleability (credit/upload links) | Fixed + exhaustive test |
| Load (local, LLM off) | p95 ≤ 37 ms up to 300 concurrent shoppers, 0 errors; soak 168 s 0 errors |
| Staging deploy, backups, restore drill, monitoring DSN | RELEASE_BLOCKED (Railway access; B-11, B-12) |
| Website installation (5 stores) | RELEASE_BLOCKED (B-10) |


## Release reconciliation (2026-10-14, later)

| Item | Result |
|---|---|
| PR #28 head `7ce3931`, PR #21 head `6950060` | CI green on every job (build-test, e2e-postgres, migrations-empty-db, docker-build, command-center, sbom; widget build) |
| Merge to `main` | **Not performed** — the engineering session's permission policy blocks merging without review. Owner action. |
| Staging | Still running the **August** build `63425e0` (2026-08-28). The October release is **not deployed and not verified on staging**. A 21/21 read-only check against the August build only proves the script works and that the old build serves no simulated vehicles — it is **not** acceptance of this release. |
| Production dependency advisories | 0 (`deepmerge-ts` pinned ^8 via overrides) |
| Real-model AI | Infrastructure complete (spend cap, load shedding, cost metering, status, probe, live eval harness); **no provider key available** → not verified |
| Five-store simulation | 3,000 scenarios / 9,319 turns, 0 P0/P1/P2 |
| Blind hold-out #2 | first run 75/84 (89.3%), fixed to 84/84 (no longer blind) |
| Browser matrix | sales journey on all five engines incl. iPhone Safari; isolation on WebKit |

## Release continuation (2026-10-14, evening)

| Item | Result |
|---|---|
| CI for `3b96329` | **green on all 6 jobs** (run 38584499775) — superseded by the commit below, which needs its own green run |
| Staging acceptance can no longer pass on an old build | `scripts/staging-acceptance.sh` now requires the expected SHA and three October-only release markers. Against today's staging (August `63425e0`) it **fails 3 markers** — correct. Wired into `deploy.yml` after staging smoke with `github.sha`. |
| Deploy preflight | `scripts/env-preflight.js` in both deploy jobs: names-only check of the variables this build needs to boot (prod-mode `CORS_ORIGINS`, `INTEGRATION_ENCRYPTION_KEY`; prices when a dollar cap is set), before migrations run |
| Dollar spend cap | `LLM_DAILY_BUDGET_USD` (group) + `LLM_TENANT_DAILY_BUDGET_USD` (per store), atomic Redis counters shared by replicas, fail closed when unpriced, boot refuses a cap without prices; `/api/ops/ai/status` shows spend vs caps and the caller's store spend |
| Grounding gap closed | model-written knowledge answers now pass the grounding guard (previously only polished rewrites did); router exceptions can no longer break a reply |
| Genuine-model proof | every chat reply carries `provenance.languageModel` (`polished`/`answered`/`discarded`/`none`) |
| Live-model eval | in-process: 124 cases / ~340 turns (hold-out + generated full journeys for all five stores), oracle + DB invariants + isolation, model-share threshold; remote mode against deployed staging (no key in any shell). Dry-run harness check: 124 cases, 341 turns, 0 findings. Remote harness check against a local new build: 40 turns, 0 violations, provenance on every reply. **Real-model run still not possible — no key.** |
| New coverage | widget API contract e2e (8), release markers + model failure injection e2e (9), five-rooftop separation (6), USD caps (4), env (1), phone-number questions (8) |
| Defect fixed from live probe | "What's your service department's phone number?" started a service-scheduling flow → now answers from the store record or says it has no verified number and offers a callback |
| Local totals | unit 449/449 + 6 new; e2e 150/150 + contract 8/8; simulator 3,000 scenarios / 9,319 turns 0 findings; hold-outs 54/54, 84/84 |
| Exact post-merge steps | `docs/POST_MERGE_STAGING_SEQUENCE.md` |
