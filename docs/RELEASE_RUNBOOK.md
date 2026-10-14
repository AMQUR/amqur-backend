# Release runbook

1. **Branch → PR** to `main` in `amqur-backend` and `amqur-widget`. CI must pass: migrations on empty DB, typecheck, lint, unit, coverage, **Postgres e2e (incl. tenant isolation, journeys, AI eval)**, Command Center build, Docker build, SBOM, secret + destructive-migration scans.
2. **Merge** → `Deploy` workflow deploys **staging** automatically (api + worker; migrations run on container start) and runs staging smoke.
3. **Staging verification** (`docs/STAGING_PILOT_GO_NO_GO.md`):
   - `GET /api/version` shows the merged SHA; `/api/health` ready.
   - Command Center `/cc/` login (+ MFA enrollment for admins).
   - Run the sales, service and parts journeys from the widget staging host; confirm records in Command Center.
   - Integrations page: Tekion `awaiting vendor credentials`, gates closed; no customer feature enabled unintentionally.
   - Outbox: no DEAD growth; worker liveness OK.
4. **Production** (`deploy-production` job) requires GitHub environment approval **and** all gates in `PRODUCTION_BLOCKERS.md` for the features being enabled. Before approving, confirm B-15 production variables (production now refuses to boot without `CORS_ORIGINS` and `INTEGRATION_ENCRYPTION_KEY`).
5. **Employee canary → public canary** (one rooftop) per `docs/canary/*`; kill switch = tenant `featureFlags.chat=false` (takes effect on next request; no redeploy).
6. Post-deploy: smoke, synthetic conversations, logs/metrics, outbox depth, verify no flags flipped.

## Pre-merge review — PR #28 / widget PR #21 (2026-10-14)

- Migrations new to `main` (8): `20261013200000_production_completion`, `20261014010000_staff_mfa`, `20261014020000_retention_policy`, `20261014030000_messaging_campaigns`, `20261014100000_price_quote_requests`, `20261014200000_trade_appraisals`, `20261014300000_spotlights`, `20261014400000_experiments`. Scan: no DROP / column-type change / rename / NOT NULL without default; the only FK added to a table is on `ConsentRecord`, created in the same migration (no orphan risk). Index builds touch small pilot tables. They run automatically on container start (`prisma migrate deploy`).
- Browser matrix: the full sales journey now runs on Chromium, Firefox, WebKit, Pixel 7 and iPhone 14; Shadow DOM isolation on Chromium + both WebKit projects. 11 remaining skips are platform-scoped by design (desktop keyboard flow on phones, mobile-only flows on desktop, reduced-motion on one engine).
- Merge → staging deploy (automatic) → **production job waits for the GitHub `production` environment's required reviewer**. Engineering does not approve that gate.
