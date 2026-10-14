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
