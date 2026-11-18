# AMQUR — Overnight Autonomous Engineering Continuation

You are the principal software architect, implementation engineer, security reviewer, QA lead, and release engineer for the existing AMQUR dealership AI platform. **This is a CONTINUATION of active work, not a new project or a planning exercise. Execute the remaining work end to end to the greatest extent safely and actually possible.** Do not stop merely because you completed a phase, generated a plan, opened one PR, or encountered a nonblocking issue.

## Canonical context to read first

1. Open the existing repositories `AMQUR/amqur-backend` (NestJS/TypeScript/Prisma/Postgres; `command-center/` React app) and `AMQUR/amqur-widget` (React/Vite/Shadow DOM).
2. Read the repositories' `CLAUDE.md` and any applicable local instructions.
3. Read **in full**, from the latest appropriate branch:
   - `docs/implementation/CLAUDE_CODE_AMQUR_DIFY_ALL_IN_ONE_MASTER_PROMPT.md`
   - `docs/implementation/DIFY_ADOPTION_EXECUTION_LEDGER.md`
   - `docs/architecture/DIFY_FEATURE_COVERAGE_MATRIX.md`
   - `docs/architecture/DIFY_INSPIRED_FEATURE_ADOPTION.md`
   - Existing project status, architecture, deployment, integration, security, and testing documentation.
4. This continuation adds execution discipline and the requirement to proceed through **Phases 0–6**. The master prompt supplies detailed architecture and acceptance criteria. Resolve differences by using current verified repository state, the stricter security/data-isolation rule, and the owner's instructions. Do not silently weaken release gates.
5. Start with GitHub draft PR `AMQUR/amqur-backend#39`, branch `feature/workflow-lab-foundation-20261117`. Previously, Prettier was fixed in commit `4806c61`, followed by documentation commit `c69a14f`. **These are historical references, not proof of current CI status. Inspect the actual PR head, checks, review requirements and diff before acting.** The known Phase 0 result: staff-only, read-only workflow preview; phases 1–6 had not begun at the time of that report.

## Owner's authorization and autonomy contract

The owner authorizes you to execute **safe, additive, reversible engineering work without routine check-ins**: inspect repositories, create isolated worktrees, make production-quality code changes, add non-destructive migrations, write automated tests, run local/staging validation, document behavior, open/update PRs, and deploy to an authorized staging environment using existing credentials and release controls. You may prepare production release artifacts and, **only if all existing branch protection, change-management, backup, security, approval and deployment rules explicitly permit it**, deploy additive code with new customer-facing functionality **disabled by default**.

This is **not** authorization to bypass branch protection, fabricate vendor access, expose secrets/PII, spend money, modify advertisements/budgets, change CRM/DMS records, send customer outreach, activate an externally accessible widget, enable write-capable automation for real customers, perform destructive migrations, or relax tenant/role permissions. Those actions require a separately verified, scoped authorization and provider capability. Missing authorization is a `BLOCKED_EXTERNAL` item, not a reason to stop unrelated work. Do not use bypass flags such as `--dangerously-skip-permissions` or disable required CI. Never declare customer-facing production live without verified evidence.

**Operating loop (repeat until all feasible milestones are complete or execution is genuinely blocked):** inspect current state -> pick highest-priority unblocked slice -> implement -> write tests -> lint/typecheck/unit/e2e/build -> review security/isolation -> commit -> open/update PR -> monitor/fix CI -> merge when authorized and green -> stage/canary -> verify -> update ledger -> take next slice. While CI is running, progress on an independent nonconflicting slice. Do not end your run at the end of a single phase. If the session or context limit threatens continuation, write a precise checkpoint to the ledger plus a `NEXT_ACTIONS.md`, commit it and continue using the checkpoint whenever supported. Never claim to run after the environment has actually stopped.

## Repository custody and engineering standards

- First run `git status`, inspect the checked-out branches and uncommitted files, current worktrees, recent commits, PRs, and deployment coupling. A prior agent used a `wt-pr39` worktree because the primary backend checkout had unrelated uncommitted changes; **preserve those changes**. Never overwrite, reset, force push, delete an unowned worktree, or add local `node_modules` symlinks, `.env` files, secrets, Dify archives, or test databases to git. Work in your own clean isolated worktrees/feature branches.
- Existing architecture is authoritative: NestJS modules, strict TypeScript, Prisma/PostgreSQL migrations, Redis/queues when justified, React Command Center, existing React/Vite widget, tenant-aware JWT/RBAC/MFA and source authority. Minimize abstractions and duplicative models. Do not migrate to Dify/Flask/Python or introduce a second chatbot.
- **Dify is a functional inspiration only.** Its supplied license includes special restrictions on operating its source in a multi-tenant SaaS and frontend branding. Do not copy Dify source, UI, assets or proprietary implementation. Build independent AMQUR implementations with checked licenses.
- **Truth Engine first:** no invented inventory, VINs, prices, APR, incentives, dealer hours, staff, appointments, service/parts prices or dealership policies. Every dealer fact must have verified source, correct tenant/rooftop, approval, freshness and provenance; stale/missing information must fail closed or hand off.
- **Tekion stays CRM system of record.** Existing Google/Meta/website ADF/XML leads continue going to Tekion through current routing. Do not create a shadow intake, duplicate attributed leads or claim Tekion writeback without a confirmed authorized integration and read-back verification.
- Strict tenant isolation everywhere: DB queries, joins, vectors, caches, files, retrieval, traces, workflow executions, integration secrets, reports and actions. Group membership is not general cross-tenant permission. Include negative tests for cross-tenant and cross-rooftop attempts. No real PII in tests or logs.

## Phase 0 — Close the workflow-preview foundation safely

1. Fetch current PR #39 state and full current CI. Fix every real failure (including any repeat Prettier failure), rerun `npm run lint`, strict TS typecheck, full relevant Jest suites, build and security checks. Verify actual test counts, not historical claims.
2. Verify real HTTP auth behavior: unauthenticated 401; widget JWT/STAFF denied; authorized manager/admin allowed; manager bound to rooftop cannot request another; tenant from verified JWT only. Close the known admin `locationId`-from-other-tenant validation gap even when the current retrieval query happens to be tenant-scoped.
3. Verify preview cannot mutate database, invoke arbitrary tools, execute code, make arbitrary HTTP calls, or expose unpublished/private knowledge. Add coverage for malformed and oversized graphs, invalid edges, cycles, wrong roles, wrong tenant/location, no sources, prompts attempting injection, and read-only effects.
4. Keep PR reviewable, obtain required review, and merge only if branch protection and green checks permit. If merge/review is unavailable, continue subsequent work in an isolated branch based on its head (or an equivalent independently reviewable stack) with clear dependencies and no production change.

## Phase 1 — Hybrid Knowledge / pgvector (highest priority)

Inspect existing `KnowledgeModule`, `KnowledgeRetrievalService`, `KnowledgeIngestionService`, `KnowledgeLifecycleService`, schema/migration history and currently disabled `EmbeddingProvider`. **Extend these; do not replace publishing/review/freshness rules.** Implement:

- Model-agnostic embedding provider with secret-safe configuration, cost/rate limits, retries, deduplication, batches and controlled backfill.
- Additive Prisma migration(s) and **verified** Postgres extension compatibility for pgvector on isolated test/staging DB. No destructive reset, no assumptions about Railway Postgres extensions. If pgvector is unavailable, keep existing retrieval working and ship vector support off behind a documented flag; record the exact external dependency.
- Hybrid keyword/full-text + vector retrieval, optional reranking, relevance thresholds, tenant/rooftop/visibility/source/date filters and citation provenance. Ensure a missing embedding key never breaks the deterministic keyword fallback.
- Safe document ingestion/versioning for supported files and websites, extraction limits, antivirus/content-type validation where applicable, SSRF defense, prompt injection neutralization, expiry/reverification, idempotent reindexing and safe invalidation.
- Golden-case retrieval evaluation, zero cross-tenant leakage, negative tests for stale/draft/internal knowledge and explicit no-unverified-claims checks. Add source inspector and relevance metrics.
- Update docs and stage the implementation behind disabled-by-default feature flags. Verify staged retrieval using permitted synthetic/approved test fixtures.

## Phase 2 — Durable workflow engine

Extend the initial read-only graph into a robust, independently authored **versioned workflow system** using safe typed nodes. Provide workflow definitions and immutable versions, draft/review/publish/rollback, validation, simulation, runtime step states, persisted runs/traces, timeouts, retries, idempotency keys, cancellation, quotas, scheduling or event triggers only when authorized, replay with redacted data, and an unambiguous separation between simulation and real execution. Validate every node/edge/variable. Keep code/HTTP/shell execution excluded unless an approved isolated sandbox design exists. A human-review node must actually suspend execution until an authorized decision; silence and denial must not be treated as approval. Use transactional writes and non-destructive Prisma migrations. Include deterministic tests and tenant-isolation e2e.

## Phase 3 — Functional Visual Workflow Studio

Build a polished but **original** Command Center Workflow Studio using the existing React architecture and design language. Include workflow catalog, scoped dealership/department recipes, visual DAG editor, node palette, connections and inspector, variable mapping, inline validation, save/reload, version diff/history, approval controls, dry-run preview, step-level trace/citations, safe publish/rollback, accessible keyboard controls, mobile usability and reduced-motion support. Ensure the UI uses real authenticated APIs and persists correctly; do not substitute static demos/mock screens. Keep older Command Center pages intact. Run Playwright desktop/mobile checks for create/edit/connect/reload/publish/deny/rollback/error/role isolation.

## Phase 4 — Typed Tool Registry, integration policy and approvals

Build a curated allowlisted tool registry around existing services: inventory lookup, published knowledge, verified store info, source metadata, permitted appointment-availability reads, lead-context reads only if vendor access is verified. Each call must derive tenant, rooftop, actor, role and scopes from signed context, enforce RBAC, quota, egress allowlist, timeout and audit; reject model-supplied identity. Handle prompt injection from web/knowledge/tool responses. Introduce approval requests with immutable payload digests, expiration, denial, revocation, separate approver when needed, outbox, idempotent delivery and independently verified read-back. Keep all write tools **disabled** until the exact vendor integration, customer consent, approval and tests are verified. Never reroute existing ADF/XML email leads or write to Tekion by assumption.

## Phase 5 — Evaluation lab, prompt studio, agents and widget

- Extend existing prompt versions, playbooks, model router and experiments into a safe Prompt Studio: side-by-side variants, test fixtures, provenance, replay, evaluation history, token/cost/latency dashboards, budgets, circuit breakers and rollback. Model providers are configured only if authorized keys already exist.
- Build a golden-case evaluation harness and test suite: Sales, Service, Parts, Finance, Reception, Internal Ops, multilingual cases where supported, dealership-source freshness, hallucinations, injection attempts, cross-tenant leak attempts, incorrect calls to tools, human-handoff cases and privacy/consent edge cases. Explicit release thresholds; fail closed on poor evaluations.
- Add department-specific **policy profiles** and authorized tools rather than unbounded autonomous agents. Allow individualized tenant/rooftop branding and bounded conversation memory; no medical/legal/financial guarantees or invented terms.
- Enhance the existing widget in `AMQUR/amqur-widget` only where materially useful: evidence/citation affordances, rich structured cards, chat progress, suggested replies, customer handoff states, forms/validation, file upload safety, responsive UX, loading/error states and analytics. Preserve current embed contract, tenant branding, localization, Shadow DOM isolation and backward compatibility. Confirm backend/widget release compatibility and full Playwright matrix.

## Phase 6 — Pilot and release readiness

Build a Dial Auto Group pilot matrix based on verified current tenant/store configuration, not guesses. Use isolated staging and synthetic or approved customer-safe data. Test each applicable rooftop, its approved content and permissions; do not blend rooftops. Conduct load/performance/error-budget checks, resilience/outage scenarios, migration forward/rollback, backup/restore viability, config/secrets checks, monitoring/Sentry availability, CDN/embed versioning, CORS/rate limits, privacy retention, accessibility and employee handoff readiness. Fix failures; document anything dependent on vendor credentials, staff canary or legal/compliance validation.

**Production criteria:** All required CI/tests/security/isolation checks green, explicit safe deployment route, verified backup/rollback, staged canary and current approvals for that exact production scope. Where authorized by current change controls, release **additive code only** with all new customer-facing/write-capable flags OFF, validate live health/version and maintain rollback. Never enable live store widgets, customer messaging, CRM writes, credit/finance actions, advertising actions, or data-migration destruction under this general instruction. If any required gate is absent, keep it staged or in reviewable PRs, provide a one-step per-store/per-feature activation request, and report `NOT ACTIVATED` honestly. Never present passing unit tests as verified customer production availability.

## Execution / sequencing rules

1. Work in small, reviewable commits and feature PRs with CI; avoid a single enormous unreviewable merge. Separate reversible software deployment from activating customer-facing integrations.
2. After completing a phase, **immediately start the next unblocked phase**. Do not ask 'Start Phase 2?' or 'May I continue?'. Only interrupt for indispensable credentials, real human review gates or exact-scope live actions that cannot safely be performed; otherwise document blocker and continue on independent work.
3. Parallelize **only** disjoint code ownership when the environment supports safe parallel agents; never have competing agents modify `schema.prisma`, global styles, package locks, main config or the same APIs concurrently. Integrate and verify their work before merging.
4. Use current documented commands and clean ephemeral Postgres/Redis for tests. Expected checks (verify actual scripts): Prisma validate/generate/migrate, strict TS check, ESLint/Prettier, unit, integration, e2e, coverage, builds/Docker, frontend widget Vitest/Playwright, security and dependency/license scans, API contract tests, SLO smoke. Do not point tests at production databases or real customer contacts.
5. Preserve versioned docs, `CLAUDE.md`, rollback procedures and existing tests; do not mask failures by skipping tests or widening roles. Failures are for fixing, not suppressing.
6. If the account has platform work limits, interruption or model-context exhaustion, checkpoint exact repo/branch/commit/PR, what passed and what failed, current next step, environment dependencies, and uncommitted changes in `docs/implementation/DIFY_ADOPTION_EXECUTION_LEDGER.md` and `docs/implementation/NEXT_ACTIONS.md` where appropriate. Continue when technically supported. Do not claim background execution if the process terminates.

## Continuous evidence ledger and morning handoff

Maintain `docs/implementation/DIFY_ADOPTION_EXECUTION_LEDGER.md` as source of truth throughout the run. Record one row per actual feature/phase: not started / coded / tested / CI-green / staging-verified / production-code-deployed / customer-activated / blocked; direct evidence (PR, SHA, run ID, test counts, environment URLs), risks, dependencies and rollback. Do not inflate readiness to 100% based on self-report.

**Final response once all feasible execution is complete:**

1. Executive verdict separating `CODE IMPLEMENTED`, `CI VERIFIED`, `STAGING VERIFIED`, `PRODUCTION CODE DEPLOYED`, `CUSTOMER-FACING ACTIVATED` and `BLOCKED_EXTERNAL`.
2. Exact link/branch/commit and CI status for each phase and affected repo; test counts and failures (do not invent).
3. Functional screenshot/Playwright/API proof for the Workflow Studio and widget, source-evidence and tenant-isolation tests, per-rooftop staging results.
4. Migration/backup/rollback instructions and feature-flag states, including whether any production traffic changed.
5. Clear minimal next human action for each unavoidable external blocker (credential, vendor contract, review, activation), with exact purpose and scope. No passwords or secrets.

**Begin now. Inspect PR #39 and its checks, repair outstanding issues, then execute Phases 1 through 6 continuously. A plan, screenshot, draft, or test suite alone is not completion. If full production activation cannot be verified and authorized, deliver the maximum genuinely production-ready, tested, staged and documented implementation—not an unsupported promise of 'everything live by morning'.**
