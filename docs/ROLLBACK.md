# Rollback

| Layer | Action |
|---|---|
| Customer traffic (fastest) | Set tenant/location `featureFlags.chat=false` (or remove origin from `allowedOrigins`) — widget fails closed immediately, no redeploy |
| Language model, one store | Command Center → Rooftop settings → Emergency AI controls (`POST /api/ops/locations/:id/ai-control` `{llmDisabled: true}`) — replies become deterministic, audited, no redeploy |
| Language model, all stores | Remove `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` from the Railway service (redeploys) — every reply falls back to the deterministic path |
| Specific capability | Turn off its flag (`inventory`, `payments`, `appointments`, `sms`, `tekionIntegration`, …) |
| API/worker | Railway → service → Deployments → previous deployment → Redeploy (staging: `api`, `worker`; production likewise) |
| Widget | Railway → `widget` → redeploy previous deployment, or re-point the embed to the previous versioned IIFE (immutable assets) |
| Campaigns | Disable campaign (version bump stops in-flight steps) |
| Database | Do **not** run down-migrations. All new migrations are additive; previous code ignores new tables/columns. |

October release specifics (PR #28): the 8 new migrations add tables/columns only, so redeploying
the August build (`63425e0`) on top of the migrated database is safe. If the new build fails its
boot, Railway's healthcheck keeps the previous deployment serving and the deploy job fails — the
preflight step exists so that case is caught before migrations run.

After rollback: check Delivery failures (DLQ) and replay only after the cause is fixed.
