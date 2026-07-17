# Monitoring

## Error monitoring (Sentry-compatible)

`src/observability/instrument.ts` initializes @sentry/node when
`ERROR_MONITORING_DSN` is set. It is imported first in both `main.ts` (api)
and `worker.ts` (worker), tags events with `processRole`, and stamps
`release` from `APP_COMMIT_SHA`.

**Captured:** unhandled exceptions and HTTP 5xx via the global exception
filter; worker crashes via process-level hooks.

**Redaction (enforced in `beforeSend`, unit-tested in
`instrument.spec.ts`):**
- request bodies, headers, cookies, and user identity are never sent
- connection strings (postgres/redis), bearer tokens, JWT-like strings,
  emails, phone numbers, and `key=value` secrets are scrubbed to
  `[REDACTED]`

**Inactive without a DSN** — safe locally and anywhere the owner has not
provisioned one.

### OWNER CHECKPOINT — required input

Provide an error-monitoring DSN (e.g. a Sentry project DSN):

```bash
railway variables --service api --environment staging --set "ERROR_MONITORING_DSN=<dsn>"
railway variables --service worker --environment staging --set "ERROR_MONITORING_DSN=<dsn>"
# then redeploy both services
```

After the DSN is live, run the controlled-error drill below and confirm the
event arrives with secrets redacted. **No alert-delivery evidence exists
until this happens.**

### Controlled-error drill (post-DSN)

1. Trigger one controlled 500 in staging.
2. Confirm the event appears in the monitor with `[REDACTED]` scrubbing.
3. Confirm the alert notification fires.
4. Remove any drill-only mechanism in the same session.

## Availability probes (owner action, any uptime provider)

- `GET https://staging-api.dialusnow.com/api/health` — expect 200 with
  `"database":"up"`
- `GET https://staging-widget.dialusnow.com/version.json` — expect 200 JSON

## Signals

| Signal | Source | Alert when |
|--------|--------|------------|
| Readiness | `GET /api/health` | not 200 / `ok=false` |
| Liveness | `GET /api/health/live` | not 200 |
| Escalations created/notified/queued | in-process metrics + audit logs | notify rate << create rate |
| Outbox DEAD | `OutboxEvent.status=DEAD` | any growth |
| Inventory import failures | `InventoryImportRun` | FAILED / REJECTED_ANOMALY |
| Auth failures | login audit | spike |
| 5xx rate | Railway / reverse proxy | error budget burn |

## Correlation

Every response exposes `X-Request-Id`. Include in logs and support tickets.

## Metrics today

Staff `GET /api/metrics` (in-process). For multi-replica production, export Prometheus/OTLP (follow-up).
