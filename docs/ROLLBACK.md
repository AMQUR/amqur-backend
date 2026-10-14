# Rollback

| Layer | Action |
|---|---|
| Customer traffic (fastest) | Set tenant/location `featureFlags.chat=false` (or remove origin from `allowedOrigins`) — widget fails closed immediately, no redeploy |
| Specific capability | Turn off its flag (`inventory`, `payments`, `appointments`, `sms`, `tekionIntegration`, …) |
| API/worker | Railway → service → redeploy previous deployment |
| Widget | Re-point the embed to the previous versioned IIFE (immutable assets) |
| Campaigns | Disable campaign (version bump stops in-flight steps) |
| Database | Do **not** run down-migrations. All new migrations are additive; previous code ignores new columns. |

After rollback: check Delivery failures (DLQ) and replay only after the cause is fixed.
