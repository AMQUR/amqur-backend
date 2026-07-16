# Monitoring

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
