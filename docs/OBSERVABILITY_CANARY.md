# Production observability — Dial Auto Group canary

## Status
In-process metrics + health endpoints exist. **External dashboards/alert routing not yet wired** (no Datadog/PagerDuty/Slack webhook credentials found).

Do not route alerts to unverified recipients.

---

## Existing endpoints (staff-auth where noted)

| Signal | Source |
|---|---|
| Liveness | `GET /api/health/live` |
| Readiness (DB) | `GET /api/health` |
| Integration health | `GET /api/integrations/health` (staff) |
| Counters | `GET /api/metrics` (ADMIN+) |

Known counters: `chat.requests`, `inventory.hit`, `inventory.miss`, `escalations.created`, `escalations.notified`, `inventory.import.succeeded|rejected|failed`, `ai.llm.success|failure|unavailable`.

**Constraint:** metrics are process-local until multi-instance shared store is configured.

---

## Required dashboards before customer traffic

1. Widget bootstrap success rate  
2. Chat success rate / latency p95  
3. Backend availability  
4. Inventory freshness age  
5. vAuto import success / anomaly rejects  
6. Tekion availability (when enabled)  
7. CRM writeback success  
8. Appointment-operation outcomes (request vs confirmed)  
9. Human handoff success  
10. No-result search rate  
11. Unsupported-claim block rate  
12. Queue depth / DLQ (when workers exist)  
13. DB + Redis health  
14. Error rate  
15. Lead + appointment conversion (analytics export)

## Alert definitions (configure when routing destination exists)

| Alert | Condition (initial) | Action |
|---|---|---|
| api_down | health fail 2m | page on-call; pause canary tag |
| inventory_stale | freshness > location SLA | disable inventory flag; pause canary |
| token_cors_spike | 403/CORS > baseline×5 for 5m | pause GTM tag |
| unsupported_claim | any production hit | immediate pause + review |
| cross_tenant | isolation canary fail | kill switch all rooftops |
| tekion_circuit_open | breaker open > 10m | disable tekionIntegration |
| cwv_regression | LCP/INP materially worse | rollback tag |

## Routing placeholders

Set only after verification:
- `ALERT_WEBHOOK_URL` (Slack/Teams) — **not configured**
- PagerDuty routing key — **not configured**
- Email on-call — **not configured**

## Canary auto-pause

Until external alerting exists, pause manually via:
1. Disable GTM AMQUR tag on jeepofchicago.com  
2. Or set location `featureFlags.chat=false`  
3. Or redeploy prior widget IIFE / backend revision (`scripts/rollback-staging.sh` pattern for staging; production image rollback once prod exists)
