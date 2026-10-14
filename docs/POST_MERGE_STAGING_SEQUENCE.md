# Post-merge staging sequence — October 2026 release

Run in this order the moment the owner merges. Every step names its pass condition. **Nothing
here touches production**; the production jobs stay paused on the GitHub `production`
environment reviewer (AMQUR), which engineering never approves.

Status today (2026-10-14): staging runs the **August** build `63425e0`. The October build is
**not deployed and not verified**. `scripts/staging-acceptance.sh` against staging today
**fails 3 release markers** — by design: it can no longer pass on the old build.

## 0. Before merging (owner)

| Check | Pass condition |
|---|---|
| Backend PR AMQUR/amqur-backend#28 CI on its **head SHA** | all 6 jobs green (`gh pr checks 28 -R AMQUR/amqur-backend`) |
| Widget PR AMQUR/amqur-widget#21 CI on its head SHA | green |
| Merge order | **backend first**, widget second (the new widget calls `/public/spotlights` and `/public/store-status`; it degrades to "no spotlights / unknown hours" on the August API, but the intended pairing is new API + new widget) |

## 1. Merge backend → automatic staging deploy

The `Deploy` workflow on `main` runs, for the merge commit `$SHA`:

1. **Preflight** (new): `railway variables … --json | node scripts/env-preflight.js` for `api` and
   `worker`. Prints names and present/missing only. Fails **before** migrations if this build could
   not boot: `DATABASE_URL`, `JWT_SECRET` (≥32), and when `NODE_ENV=production`, `CORS_ORIGINS` and
   `INTEGRATION_ENCRYPTION_KEY` (≥32); a dollar cap without both token prices.
   - If it fails: owner adds the named variable in Railway → staging → service → Variables, then
     re-runs the job. (Staging already restricts CORS — an unauthorized origin is not reflected —
     so `CORS_ORIGINS` is set; `INTEGRATION_ENCRYPTION_KEY` cannot be confirmed without Railway
     access.)
2. Deploy `api` + `worker`. Container start runs `npx prisma migrate deploy` (8 additive
   migrations, reviewed in `RELEASE_RUNBOOK.md`), then boots. Railway's `/api/health/live`
   healthcheck gates traffic; a failed boot keeps the August deployment serving.
3. Staging smoke (existing): `verify-release.sh` with `$SHA`, DB up, five widget-configs 200,
   unauthorized origin 403.
4. **Staging acceptance** (new): `scripts/staging-acceptance.sh https://staging-api.dialusnow.com $SHA`
   — deployed SHA must equal `$SHA`; October release markers (`checks.llm` in `/api/health`,
   `/api/public/spotlights` 200, `/api/ops/ai/status` 401); five stores; no simulated vehicles;
   no credit-destination leak.

Watch: `gh run watch -R AMQUR/amqur-backend $(gh run list -R AMQUR/amqur-backend --workflow Deploy --branch main -L1 --json databaseId -q '.[0].databaseId')`

Pass condition: the `deploy-staging` job is green **for the merge SHA**. Only then is the October
backend "deployed to staging and accepted". The `deploy-production` job will then show
"Waiting for review" — leave it.

## 2. Merge widget → automatic widget staging deploy

Pass condition: widget `deploy-staging` green; `https://staging-widget.dialusnow.com/version.json`
`commitSha` = the widget merge SHA.

## 3. Engineering verification on staging (read-only / anonymous conversations)

```bash
bash scripts/staging-acceptance.sh https://staging-api.dialusnow.com <backend-merge-sha>
```

- Widget journeys from the staging widget host (Playwright specs in `amqur-widget/e2e/staging`, if
  the staging origin is allow-listed for the five tenants).
- Command Center `/cc/` login, AI status page (`GET /api/ops/ai/status`): providers, spend,
  caps.

## 4. Real-model verification (after the owner sets the staging AI key)

Owner action: Railway → staging → `api` (and `worker`) → Variables:
`ANTHROPIC_API_KEY`, and the spend controls — `LLM_DAILY_BUDGET_USD` (e.g. `25`),
`LLM_TENANT_DAILY_BUDGET_USD` (e.g. `5`), `LLM_COST_INPUT_PER_MTOK` and
`LLM_COST_OUTPUT_PER_MTOK` from the provider's current price sheet (no prices are hard-coded),
optionally `LLM_DAILY_TOKEN_BUDGET`, `LLM_MAX_CONCURRENCY`. The variable change redeploys.

Then engineering runs (no key needed in the shell — it tests the deployed service):

```bash
LIVE_MODEL_EVAL=1 LIVE_MODEL_TARGET=https://staging-api.dialusnow.com npm run eval:live-model
```

Pass: zero claim-safety violations across the five stores, `provenance.languageModel` present on
every reply (proves the October build) and ≥ 30% of replies model-shaped (proves the key is live).
Evidence: `test/evidence/live-model-remote-latest.json`.

Full in-process evaluation (the owner's key in a local shell; never written to a file):

```bash
LIVE_MODEL_EVAL=1 ANTHROPIC_API_KEY=… LLM_DAILY_BUDGET_USD=10 LLM_COST_INPUT_PER_MTOK=… LLM_COST_OUTPUT_PER_MTOK=… npm run eval:live-model
```

124 cases / ~340 turns across the five simulated stores (hold-out set + generated full journeys),
independent oracle, DB invariants, tenant isolation; pass = P0 0, task success ≥ 95%, model
share ≥ 30%. Harness self-check without a key: `LIVE_MODEL_DRYRUN=1 npm run eval:live-model`
(2026-10-14: 124 cases, 341 turns, 0 findings, DB invariants clean).

## 5. Defects found → fix → PR → CI on the exact SHA → merge → repeat 1–4

## 6. Store readiness — one store at a time

Green CI and a green staging run release **no store**. A store's capability goes live only with
its signed approval line (`FIVE_STORE_ONBOARDING_PACKETS.md`), verified store data, an
allow-listed production origin, and the production reviewer's approval. Onboarding configs ship
with no origins and conservative flags (`src/config/rooftop-separation.spec.ts` enforces it).

## Rollback (any step)

See `ROLLBACK.md`. Migrations are additive — redeploying the previous Railway deployment is safe
without touching the database.
