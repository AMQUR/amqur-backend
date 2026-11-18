# CLAUDE CODE MASTER EXECUTION PROMPT: AMQUR AI Dealership Operating System

**Objective:** Independently build the useful product capabilities demonstrated by the user-supplied Dify source into the existing AMQUR platform, end to end. This is an **implementation mandate**, not a research-only or mockup-only task. Do not replace AMQUR with Dify, do not create a second parallel chatbot, and do not deploy Dify as our multi-tenant SaaS. Preserve existing dealership behavior and improve it in coherent, testable increments.

**User authorization:** You may inspect, analyze, plan, create feature branches, edit code, create non-destructive migrations, run tests, create documentation, open and update pull requests, and develop against isolated local/staging environments. Work autonomously without routine confirmation questions. However, this is NOT blanket permission to bypass vendor access restrictions, branches/review gates, make payments, send customer messages, change advertising spend, alter CRM/DMS data, expose PII, switch on live widgets, perform destructive operations, or publish to production. Those actions require exact-scope authorization, approvals and independent verification. If blocked, complete the next safe workstream and record the blocker rather than stopping all work.

## 0. Inputs and repository custody

1. Primary repositories (verify live contents; never assume they match this brief):
   - `AMQUR/amqur-backend` (NestJS, TypeScript, PostgreSQL/Prisma, Redis, backend modules; currently contains a React/Vite Command Center under `command-center/`).
   - `AMQUR/amqur-widget` (React/Vite/Shadow DOM embedded dealership widget).
   - Do not modify dealership website repositories, advertising accounts or unrelated repos unless a clearly scoped task requires it.
2. Current integration start: `AMQUR/amqur-backend` draft PR **#39**, branch `feature/workflow-lab-foundation-20261117`, containing an original staff-only workflow preview. Inspect current state, CI and review comments first; do not claim it is green, merged or deployed without evidence. An earlier TypeScript failure in `workflow-preview.service.ts` was patched by explicitly typing the `Map<string, WorkflowNode>`; recheck CI after the patch.
3. Source references: platform `CLAUDE.md` / existing repo docs; `docs/architecture/DIFY_INSPIRED_FEATURE_ADOPTION.md` on PR #39; the provided AMQUR AI Dealership Platform reference; uploaded `dify-main.zip` if present in the workspace. If absent, do not block: use the source-derived feature matrix below and the existing blueprint. Do not ask for the archive merely to start implementation.
4. Before changing code, inspect `git status`, current branch, CI/deployment coupling, tracked and untracked files, migration history, and relevant design patterns. Never overwrite local changes, revert other contributors, force-push, or mutate secrets. Use dedicated short-lived feature branches / isolated worktrees for concurrent work, keep source of truth in existing repositories, and use proper PRs.
5. Read `CLAUDE.md` and all repo-specific agent instructions. Preserve exact existing public API contracts, customer-visible responses, feature flags, staff workflows, data schemas and tenant boundaries unless migrations and compatibility tests justify a change.

## 1. Critical licensing and originality policy

The uploaded Dify archive was inspected and contains a **modified Apache 2.0** `LICENSE` that requires written permission or a commercial license for using Dify source code to operate a multi-tenant environment. Its frontend logo/copyright restrictions also apply when using Dify's `web/` components; its license refers to an interactive-design patent. AMQUR is intended to serve independent dealership tenants.

**Do not fork, copy, paste, redistribute, translate source line-for-line, ship Dify assets, rebrand Dify UI, or deploy Dify server/framework into our multi-tenant product without formal legal and commercial clearance.** Treat it as a functional reference. Implement original AMQUR code. Its concepts (workflow DAG, conditional branches, tool registry, RAG, agent policies, evaluation) are product patterns, not a license to reproduce protected code or appearance. Clearly flag any dependency or asset with unresolved rights and exclude it until approved. Use ordinary license-compatible third-party libraries only after reviewing their licenses, maintenance and security posture.

## 2. Non-negotiable AMQUR product invariants

- **Truth engine FIRST** for customer facts. Inventory, vehicle price, MSRP, incentives, APR, financing offers, store hours, staff, appointment availability, service rates, parts, policies, trade estimates and special offers may ONLY be stated when supported by the appropriate current tenant-specific verified source, including provenance and freshness. Missing or stale information yields a truthful limitation and helpful escalation; never have an LLM guess.
- **Do not disrupt Tekion attribution.** Dial Auto Group currently funnels Google Ads, Meta Ads, website and other leads via authorized ADF/XML email intake into Tekion CRM. Tekion remains the CRM system of record. Do not redirect, bypass or duplicate lead-source routing. AMQUR can enrich analytics and, once permission/API contract is verified, append idempotent authorized notes or read sync state. A CRM dashboard is not a substitute for Tekion's source accounting.
- **Multi-tenant isolation is mandatory.** Tenant from trusted JWT/server context, not model-generated values or request JSON. Rooftop-level visibility and DealerGroup membership are separate. All persistent rows, search filters, cache keys, embedding indexes, job payloads, storage objects, traces, memory, prompts, integrations, tool credentials and analytics must enforce tenant boundaries. Negative cross-tenant tests are release blockers.
- Strong role- and location-based authorization, MFA where existing, approval separation of duties and permanent auditability for any state-changing action. Never silently elevate permissions.
- Default fail-closed on absent provider credentials, stale data, unresolved billing policy, unreachable budget counters, disabled tenant flag, tool failures and unapproved outbound actions. User prompts and retrieved documents are untrusted data and cannot grant privileges.
- Never hardcode product-facing name (branding not finalized), production domain, vendor credentials or assumed dealership details. Retain configurable white-label tenant branding.
- Preserve existing auth/role, public widget contract, database migrations, feature-flag patterns, Outbox/Inbox/idempotency, data retention and privacy practices.
- Keep code in strict TypeScript, modular NestJS services, validated DTOs and predictable REST responses; prefer composition and existing modules. No gratuitous rewrite, new Python backend or duplicated microservices.

## 3. Autonomous working protocol

You are acting as principal product engineer + architect + security engineer + QA lead. **Execute**, rather than only writing a plan. Maintain a `docs/implementation/DIFY_ADOPTION_EXECUTION_LEDGER.md` covering verified baseline, milestones, each feature's owner/branch/PR/commit, commands and test receipts, blockers, rollout/rollback, dependency licenses and evidence. The ledger must never claim completion on assumption.

Loop for every feature: inspect existing code -> classify existing/partial/missing -> define contract and threats -> write targeted tests -> implement minimal complete vertical slice -> run typecheck/lint/unit/e2e/security -> verify actual UI/API -> document -> commit -> PR -> assess deployment gate -> continue. Prefer parallel agents only for nonoverlapping files; define ownership upfront. Never let multiple agents simultaneously modify root modules, Prisma schema, global state, lockfiles or shared styles.

Review CI on PR #39. Fix actual compile/lint/test failures, add negative staff-vs-widget and tenant/location access tests, then request/obtain required review. If CI-green, merge only when branch rules and production-deploy coupling are verified; otherwise leave reviewable draft and continue in a separate branch. **Never bypass branch protection or merge a failing PR.**

If a step requires a credential, irreversible customer-facing operation, production deployment or vendor permission unavailable to you, create a precise `BLOCKED_EXTERNAL` ledger item with exact requested approval/secret name (never value), affected tenant/store, rollback, evidence and next dependency. Finish independent tasks elsewhere. Do not fabricate integration success or a '100/100' score.

## 4. Feature strategy and priorities

### P0-A. Source-grounded hybrid Knowledge Engine

Existing AMQUR baseline: `KnowledgeModule`, `KnowledgeLifecycleService`, ingestion/chunking, `KnowledgeRetrievalService` using keyword scoring; `EmbeddingProvider` exists but is currently disabled; current customer retrieval filters for PUBLISHED and CUSTOMER-visible knowledge plus effective/expiry windows. Extend those instead of building new parallel tables.

Implement provider-agnostic embeddings (secrets server-side), tracked embedding model/version, incremental re-embedding jobs, stable source-to-chunk provenance, tenant/rooftop access filters, Postgres pgvector migrations with guarded rollout, vector + lexical hybrid ranking and reranking if warranted. Support approved PDF/DOCX/HTML/FAQ/CSV/text sources and verified website page ingestion using secure size/content/URL restrictions. Preserve publication/approval/reverification states. Implement source conflict detection, stale source handling, recrawl/reindex diagnostics, evidence snippets, source links, document versions, evaluation hit tests and hard deletion/revocation. No answer is considered verified merely because semantic similarity is high or a published document matches a keyword; freshness and authority still apply.

Gate: isolation tests (A query cannot return B documents/chunks/vectors), prompt-injection corpus, stale/expired/unpublished exclusion, re-embedding idempotency, bad file/SSRF defenses, retrieval evaluation on curated dealership cases, storage safety and rollback.

### P0-B. Workflow definitions, schema and safe graph runtime

Build upon `src/workflow-lab/*`, once PR #39 is green and appropriately integrated. Introduce independently authored, discriminated-union node contracts (schemaVersion, node IDs, typed inputs/outputs, connections, config bounds, permitted node types), validation of branches, safe loops/cycle handling (default acyclic), resource/time budgets and no unbounded execution. Add versioned definitions, draft/review/publish/rollback, immutable versions, preview/simulation and run/step traces via non-destructive Prisma migrations.

Initially allow read-only nodes: Start, verified Inventory Search, Published Knowledge Search, Verified Store Info, If/Else, Classifier (guarded model output), Set Context, Format Reply, Human Review, End and deterministic fallback. Support typed variables, mapped outputs, error/timeout branches, fail-closed conditions and trace redaction. Never run arbitrary shell/Python/JavaScript, arbitrary HTTP requests, browser automation or third-party MCP servers through an end-user conversation.

Later add async continuations using the existing worker/Redis patterns; introduce BullMQ only if justified by code and worker architecture. Durable run state, idempotency, bounded retries/backoff, cancellation and deadlines, tenant-aware scheduling, and correlation IDs. Never infer that a `preview complete` status proves a customer fact or a real action succeeded.

Gate: valid/malformed graph suite, DAG/cycle/budget rejection, cross-tenant run access denial, no phantom writes, failure/retry/idempotency tests, deterministic replay and redacted traces.

### P0-C. Typed Tool Registry and policy engine

Implement a server-side allowlisted registry with for each tool: stable key, version, department, read/write class, tenant/location applicability, required role/consent, verified data contract, request/response DTO, allowed network destinations, timeout/quota/circuit breaker, idempotency requirement, audit schema, approval class, cost and health checks. The model proposes a tool request, **the policy engine decides**; it cannot alter its own policy by text.

Read-only tools first: inventory VIN/stock/filter search, authorized knowledge search, verified business hours, available dealership contacts, parts inquiry status and authorized appointment lookup only if provider actually supports it. Use existing implementations rather than replacing them. Never claim a tool is connected until live test evidence proves it.

Write tools only with exact scoped approval: human handoff, consented appointment request, CRM comment, send message, quote/offer, finance or trade operations. Store write intent digest, approver and expiry. Use transactional outbox/inbox, dedupe, replay protection, consent/quiet hours, immutable audit events, post-execution verification and denial/no-response = NO ACTION. Production-changing actions always remain gated by tenant-specific permissions and external authority.

Gate: prompt-injection cannot call unauthorized tool, customer JWT cannot run staff-only tools, false/missing approval prevents write, retries do not duplicate CRM records/leads, isolation test and audit events verified.

### P1-A. Command Center Visual Workflow Studio

Extend `amqur-backend/command-center/` with an original clean enterprise UI. Preserve existing command-center features, styling conventions and navigation; do not recreate Dify screens. Provide workflow catalog, reusable dealership templates, accessible visual graph editor, node search/palette, inspector, variable mapping, validation indicators, dry-run/test chat, step-by-step trace timeline, reference inspector, prompt version explorer, draft vs published diff, RBAC approval, version history, rollback, per-rooftop selection and trace export (PII-redacted). Use an actively maintained license-compatible React graph library if justified, otherwise build an accessible native editor. Keyboard-only and screen-reader alternatives required, responsive layout and reduced motion honored.

Gate: meaningful user journeys in Playwright at desktop and mobile; drag/connect/edit, keyboard, save/reload, version rollback, invalid graph error, tenant access denial, approval process and failure states. Screenshots/QA evidence, not only JSX compilation.

### P1-B. Prompt Studio, Model Gateway and Evaluation Lab

Preserve existing `LlmRouterService`, budget/circuit-breaker logic, OpenAI/Anthropic providers, playbooks, A/B experiments, and prompt versions. Add tenant/location-aware prompt test bench and visual diff, preview vs published prompts, structured outputs/JSON schema validation, compatible streaming (when supported), provider/model fallback based on consent/budget/security, cost/performance receipts, and sensible caching only for non-sensitive safe outputs.

Build a golden-case lab with: sales/used/new VIN search, price truth, expiring incentives/APR, store hours, service/parts, financing education vs offer, appointments, handoff, missing data, coercive instructions, cross-tenant leakage, prompt injection, stale sources, hallucination, PII exposure and model/provider outages. Include human-rated test cases, reproducible seeds/fixtures, version comparisons, regression gates, redacted transcript traces, cost/token/latency dashboards and safe feedback loops. Model evaluation must not silently self-approve tool permissions or promote unverified responses.

Gate: no unsupported dealership claim in selected golden cases, zero verified tenant-isolation regressions, truthful unresolved cases, tested fallback and spend cap, observable failure categories. Report denominator, test dates and exact confidence; never claim full real-world zero-error accuracy from a finite suite.

### P1-C. Department AI employees and handoff

Use modular agents/personas or policy profiles for Sales, Service, Parts, Finance, Reception, Internal Employee Assistant and voice-ready work queues. Route intent to domain-specific verified tools; preserve context, selected VIN/vehicle, trade, budget, prior conversation, appointment journey and consent. Maintain continuity during handoff to staff and between permitted channels; ensure memory is scoped, minimized and deletable. Avoid creating independent agent silos or conflicting stores of truth.

Each domain requires clearly defined authorized actions, escalation conditions, fallback behavior, evidence-backed answer contracts, golden-case tests and KPIs. Finance guidance is educational unless program/quote is verified. Trade offers and service/parts prices cannot be invented. Voice call handling and outbound messaging are feature-flagged until provider access/consent and regulations are verified.

### P1-D. Public widget + API enhancements

Extend `AMQUR/amqur-widget` rather than replacing it. Preserve embed contract, tenant branding, Shadow DOM, mobile full screen, structured vehicle cards/compare, inventory/payment estimate guardrails, new-conversation/identity model and human handoff. Integrate versioned workflow outputs behind feature flags. Add progressive streaming if backend can support it, rich response/citation cards, suggested replies, structured steps, safe file/image uploads, reasonable conversation history, language/locale where validated, resilient offline/reconnect and error handling, responsive accessible UX. Never expose privileged tool registry, secrets or internal-only docs through a widget token.

Gate: existing widget tests remain green, deterministic backend contract fixtures, Playwright desktop/mobile and accessibility, no unsafe HTML injection, 401/403 behaviors, tenant/token spoofing, payload limits, and no regression in VDP context or existing lead capture.

### P2. Connector and automation catalog (enable selectively)

Research only authorized official APIs for Tekion CRM/DMS, vAuto/inventory feeds, service and parts systems, Google Calendar, approved OEM data, Twilio, WhatsApp, Resend/SendGrid, Meta/Google attribution, GA4 and staff notifications. Do not assume access from a user's browser login, confuse marketing conversion with sold vehicle, or use scraped credentials. Implement adapter contracts, credential vault integration, simulation/test fixtures, health indicators, per-tenant configuration, consent, throttling, audit and replay. Maintain existing ADF/XML to Tekion routing unchanged. If APIs unavailable, produce honest mock provider with visible `DEMO` labeling and a precise vendor-onboarding checklist.

Create reusable dealership workflow recipes (no unauthorized marketplace/plugin code): inventory question -> verified search -> lead qualification -> human/consented CRM; service question -> knowledge -> request -> confirmation; financing education -> verified link/handoff; missed-chat recovery with consent; trade follow-up; parts inquiry; internal QA; multilingual reception. Each recipe is versioned, disabled until reviewed and tenant-bound.

### P3. Selective advanced capabilities

Only after P0/P1 passes and ROI/security is demonstrated: multimodal vehicle/photo and document explanations, OCR with safety limits, voice receptionist, batch jobs, scheduled proactive agents, curated plugin catalog and advanced analytics. Exclude untrusted arbitrary code execution, open internet agent tools or autonomous financial decisions from public conversations. A sandbox, if ever approved, must have isolation, no secrets/network by default, CPU/memory/time limits, tenant-bound execution and security review.

## 5. Data, API, observability and UI contracts

- Migrate only with Prisma migrations, never schema reset in live environments. Add necessary tenant/location foreign keys and indexes for `WorkflowDefinition`, immutable `WorkflowVersion`, `WorkflowRun`, `WorkflowStepRun`, `ActionApproval`, `ToolRegistration`, embedding/index metadata and evaluation records as applicable; do not add models without evaluating existing schema overlap. Document upgrade and rollback plan. Minimize stored customer PII.
- Staff endpoints use existing JWT/RBAC. Apply strict DTO validation, pagination, versioning, tenant/location scope in services, not UI-only guards, audit and rate limits. Public endpoints remain least-privileged.
- Prefer a consistent typed response envelope (existing backend contract). Include `provenance` with source id/type, verifiedAt/freshness and customer-safe URL only when genuinely available. Add `not_verified` reason/status instead of fabricated data. Never leak raw prompt/tool traces or PII to public users.
- Feature flags default OFF by tenant/location for new customer-facing behavior. Provide emergency kill switch, timeout fallback, metrics/traces without secrets, cost caps, per-tenant SLOs, idempotent retriable jobs and dead-letter investigations.
- UI should be polished, restrained, white-label, intuitive; do not copy Dify visual styling, logo, layouts, canvas design, icons or branded terminology. Focus on a coherent Command Center with validated responsive states, accessibility and usable workflows.

## 6. Phases and release sequence (finish each safe slice)

**Phase 0 - Baseline and CI stabilization:** Verify repos, modules, current deployments, branch protections, PR #39, actual failures and existing tests. Fix PR #39 CI; add auth/tenant negative cases, produce baseline feature gap matrix. No production effects.

**Phase 1 - Knowledge upgrade:** Deliver embeddings + vector migration behind flags, hybrid retrieval and evidence API, ingestion safety and evaluation. Staging-only verification. PR with source-controlled tests and rollback.

**Phase 2 - Durable workflow core:** Deliver graph schema, persisted definitions/versions, safe preview, read-only execution, trace, runtime fail-closed controls, test cases. Integrate existing worker and tools without unauthorized actions.

**Phase 3 - Visual Workflow Studio:** Deliver fully functional editor and preview with Command Center, developer-safe versioning/publish/rollback, UI and API e2e.

**Phase 4 - Tool policies and approvals:** Typed tool catalog, consent/role policy, approved and denied action flows, outbox/idempotency, staff approval inbox, auditable integration mocks before real provider access.

**Phase 5 - Agent/prompt/evaluation experiences:** Department agents, model/prompt lab, golden cases, tracing, costs, safe handoff, workflow templates, widget integration and end-to-end UX.

**Phase 6 - Pilot/readiness:** Staging canary for each applicable Dial rooftop with sanitized fixtures and verified sources; real-employee testing, backups, monitoring, operational runbooks, isolation/performance/load, disaster/rollback, compatibility and vendor-integration signoff. Only then produce explicit per-tenant production activation requests. No live traffic activation from broad blanket authorization.

At any point, if an independent module is blocked, continue the next safe one. No long idle pauses, no routine Q&A. Maintain a truthful state ledger and PR links so work can continue after context resets.

## 7. Verification commands and acceptance criteria

Run the repository's REAL documented commands; verify exact names in `package.json`, CI, Dockerfiles and scripts rather than assuming. Likely backend: `npm ci`, `npx prisma validate`, `npx prisma generate`, `npm run typecheck`, `npm run lint`, `npm test -- --runInBand`, platform e2e with clean disposable PostgreSQL/Redis, `npm run build`, `npm run build:cc`; widget: `npm ci`, `npm run lint`, `npm test`, `npm run build`, Playwright local/staging matrices. Use test infrastructure, **never production database for automated tests**. Run `git diff --check`, source/license/secret scans and authorization/tenant-negative suites.

Before claiming a release candidate:
- Build, lint, migrations, unit, integration, e2e, API contract and accessibility checks pass for touched components.
- Every public/customer assertion is backed by a verified, current, allowed source or a truthful unavailable state; cite evidence in QA.
- Negative tenant, token, location and role tests pass. Failsafe behavior tested when source, provider, Redis, CRM or model is down.
- All external writes go through policy, approval, idempotent outbox and independent verification; no writes from untrusted graph nodes.
- Existing Tekion email lead routing, widget embed, stored data, appointment/trade/finance workflows, latency and branding are regression-tested.
- A production release has rollback, backups, canary, owner approval, monitoring, feature flags and proof of real integration credentials. If any gate absent, leave it staged/disabled.

## 8. Required outputs at every substantial milestone

1. `docs/implementation/DIFY_ADOPTION_EXECUTION_LEDGER.md` with feature status (Existing/Improved/Implemented/Tested/Staging/Production/Blocked), source evidence, actual PRs/SHAs/CI runs, scope, owners, blockers and rollback.
2. `docs/architecture/DIFY_FEATURE_COVERAGE_MATRIX.md` mapping actual Dify behavior to AMQUR decision: **Adopt independently / Enhance existing / Defer / Reject / License blocked**, with source-of-truth references. Not every Dify feature belongs in a dealership AI operating system.
3. Updated ADRs and schema/API docs, support and privacy runbooks, source-authority decision tables, DDL migrations and tests, workflow demo recipes and screenshots.
4. A concise final owner brief: What is VERIFIED live, what is only coded, what is staged, what is mock, what failed, risk, next exact action, and readiness by capability. No unsupported '100/100' claim or fabricated success.
5. PR(s) with complete description and run receipts; never merge or deploy in violation of gates. For blocked external steps, list exactly the system permission/credential or approval that must be supplied through an approved secure mechanism. Never request secrets in chat or copy them to prompts/code/logs.

## 9. Start executing now

First, open `AMQUR/amqur-backend` PR #39, inspect the current CI, fix any real failing build/test/security check, and verify that its new preview endpoint is strictly read-only and staff-only, with tenant/location isolation. Then write the coverage matrix and work through Phases 1-6 in dependency order on separate reviewable branches. Build working, tested product slices; do NOT stop after architectural planning, design mockups or generic recommendations. Keep AMQUR's existing backend/widget and Tekion source-of-truth rules intact. Finish with evidence and exact blockers only where unavoidable.
