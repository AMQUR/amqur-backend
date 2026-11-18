# Dify-Inspired Adoption — Verified Execution Ledger

**Reconciled:** 2026-11-18 (America/Chicago). This document reflects checked GitHub PR/CI state and Railway service inventory. It supersedes outdated "not merged" statements in older commits. Keep evidence-based vocabulary distinct: `coded`, `tested locally`, `CI-green`, `merged`, `staging verified`, `production deployed`, and `customer activated`. Do not infer any later state from a previous stage.

## Executive status

The Phase 0, Phase 1a–1c, Phase 2a–2b, and Phase 3a code is **merged to `main`**. The Phase 3a Workflow Studio is **not staged or live**. GitHub Actions Deploy attempts were reported failing before the Railway build/migration step. The staging API and worker's latest confirmed successful Railway deployments are still **2026-11-07**. Customer-facing and write-capable new workflows remain disabled. Phases 1d, 3b, 4, 5, and 6 remain unverified and incomplete.

## Merge and CI receipts

| Slice | GitHub PR | Merge SHA | Evidence | Deployment |
|---|---|---|---|---|
| 0 — staff-only workflow graph preview, JWT/rooftop bounds | [#39](https://github.com/AMQUR/amqur-backend/pull/39) | `c9a6ad6` | 6 CI checks green on PR head `5b047c0` | No new staging release verified |
| 1a–1c — hybrid retrieval, opt-in embeddings, optional pgvector, synthetic eval | [#40](https://github.com/AMQUR/amqur-backend/pull/40) | `ecadbb1` | 6 CI checks green on head `43d884b`; disposable DB pgvector test, synthetic fixtures | Flags OFF; no staging pgvector/embedding verification |
| 2a — immutable workflow definitions, review, checksum, rollback | [#41](https://github.com/AMQUR/amqur-backend/pull/41) | `44754f4` | 6 CI checks green on head `7c2f9e4`; additive migrations | Not yet staged |
| 2b — simulation run records, human-review suspension, TTL, idempotency | [#42](https://github.com/AMQUR/amqur-backend/pull/42) | `4227ee9` | 6 CI jobs green on head `1a3559f`; 19 HTTP E2E scenarios including actual JWT, Postgres/Redis, cross-tenant/rooftop denial, concurrency; real-DB test | Not yet staged; workflow run tables not deployed |
| 3a — Command Center Workflow Studio | [#43](https://github.com/AMQUR/amqur-backend/pull/43) | `e61f5f0` | 6 CI jobs green on final PR head `f06e362`, GitHub runs `44325723500` and `44302050263`; local Playwright 3 desktop + 3 Pixel 7 journeys | Not staged/production-live |

For Phase 2b, the run engine remains a bounded, staff-only **SIMULATION**. It does not provide durable queued execution, resume-after-review, customer-facing workflow execution, tool calls, or CRM writes. A publication approval does not activate real customer effects.

For Phase 3a, the UI supports catalog/templates, inspector and step list, keyboard-focusable diagram, draft validation, version diff, preview, independent publish review, persisted simulation runs, and review decisions. It **does not** yet include drag-to-connect, node renaming, redacted trace export, full assistive-tech audit, or Playwright-on-CI. Local Playwright results are not GitHub CI evidence.

## Remaining engineering milestones

| Workstream | Status | Specific acceptance next |
|---|---|---|
| 1d — safe document/URL ingestion, retrieval ranking, conflict and freshness inspection | NOT STARTED | SSRF and file type limits, publication/freshness checks, tenant isolation, synthetic plus real dealership eval; separate PR |
| 3b — editor completeness/accessibility | NOT STARTED | Drag/connect, node renaming with edge rewrites, keyboard parity, screen-reader audit, trace export, mobile snapshots, Playwright CI |
| 4 — typed tool registry, action policies and approvals | NOT STARTED | All tool calls fail closed by default; per-tenant connector grants, read-only first, idempotency, independent approvals, audit logs, negative tests; no live external writes |
| 5 — prompt/eval lab, model gateway, department personas and widget | NOT STARTED | Prompt versions, golden case tests, no hallucinated prices/terms/inventory, widget contract/e2e, isolated rollout |
| 6 — five-rooftop canary, operational release qualification | NOT STARTED | Staging exact SHA + migrations, five tenant gates, denial tests, rollback, telemetry, independent production approval |

## Staging release blocker: evidence, not inference

- Railway project **`dial-us-now-platform`** (ID `3bca40b6-01c6-4f02-9464-8682e6ffcb75`), staging environment ID `e89573c2-55bd-409b-aa03-9c858feefe77`.
- At reconciliation, staging `api` and `worker` show latest successful Railway deployment timestamps **2026-11-07T18:31:40Z**; neither includes the merges above. Connected Railway OAuth can read service/variable **names**; it does **not** prove the GitHub Actions `RAILWAY_API_TOKEN` works.
- Staging `api` and `worker` each list `CORS_ORIGINS` and `INTEGRATION_ENCRYPTION_KEY` by **name**. Their values, length, and equality were **not verified**.
- The Deploy workflow's staging sync calls `node scripts/sync-worker-required-from-api.mjs staging`. That script catches errors from the Railway CLI or JSON parsing and prints the generic `could not read Railway variables`. Earlier failing deployments reported this message; **the latest #43 deployment log was not accessible through the available push-run listing interface**, so its exact failure reason remains unverified.
- A stale/insufficient GitHub Actions token is a leading hypothesis, **not confirmed diagnosis**. Other possibilities include project/environment access, CLI behavior, or unexpected output. Preserve fail-closed behavior and never copy a Railway access token into a commit, chat, PR comment, or CI stdout.

**Next operator action:** follow [Railway ↔ GitHub Actions deployment recovery](../operations/RAILWAY_GITHUB_ACTIONS_DEPLOY_RECOVERY.md). This requires the owner to verify/replace the account or workspace-scoped GitHub secret `RAILWAY_API_TOKEN` (including environment-level overrides) and then rerun the established deployment workflow. Do not bypass the workflow with an alternative privileged deploy path.

## Staging acceptance and activation boundaries

1. Confirm `deploy-staging` SUCCESS on a specific `main` SHA and verify that SHA via the API release identity; assert services, Postgres migrations, Redis, and public widget-config for each of five rooftops.
2. Run negative origin, widget-role, staff-role, cross-tenant and cross-rooftop tests on **staging**, plus first/second reviewer, cancellation/expiry, unchanged ADF/XML Tekion lead attribution, and no customer-visible new tools.
3. Check `pgvector` is available on the **actual staging Postgres** before considering embeddings; do not automatically install extensions or enable paid model usage. Confirm `OPENAI_API_KEY` only by secret existence, not exposing value; flags stay OFF until authorization and quality evaluation.
4. Capture backup/rollback and service-by-service deployment receipts. Production deploy requires the existing GitHub `production` environment reviewers and exact SHA signoff; a GitHub merge or CI green alone does not grant production activation.
5. Mark a rooftop `customer activated` only after feature flags, permissions, verified live data sources, human handoff, observability and canary acceptance have separate receipts.

## Explicit action register

| Client | Store scope | Channel / target | Finding | Action | Approval | Implemented | Verified | Rollback |
|---|---|---|---|---|---|---|---|---|
| AMQUR flagship pilot | All five rooftops, isolated | GitHub Actions `AMQUR/amqur-backend` / `RAILWAY_API_TOKEN` | Staging Deploy preflight/variable read failure; root cause unresolved | Owner checks token scope and overrides, updates Actions secret securely, reruns authorized Deploy | Owner needed for secret | No | No | Restore prior token if safely retained / disable broken workflow until corrected; never expose value |
| AMQUR flagship pilot | All five rooftops, isolated | Railway staging `api`, `worker` | New code not staged; last successful deployments Nov 7 | Run current-commit staging acceptance, migrations and tenant-isolation gates after token is repaired | Existing deployment review gate | No | No | Railway redeploy previous known-good `api` and `worker` releases |
| AMQUR flagship pilot | None customer-facing yet | Backend/Command Center phases 1d, 3b, 4–6 | Open development backlog | Independent reviewable PRs with test evidence, no live writes | Internal code development permitted | No | No | Revert additive feature PR and leave flags OFF |

## Documentation maintenance rule

Update this ledger from real GitHub CI run/PR statuses and Railway deploy IDs after every meaningful implementation or release. Prior commits containing old pending/blocked states remain available in Git history; do not carry those historical statuses forward as current truth.
