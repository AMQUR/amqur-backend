# Observability

- **Correlation:** `RequestIdInterceptor` sets/propagates `X-Request-Id`; outbox events carry ids; scheduler calls pass `correlationId`.
- **Errors:** Sentry-compatible instrumentation (`src/observability/instrument.ts`), active when `ERROR_MONITORING_DSN` is set (B-12).
- **Metrics:** `GET /api/metrics` (ADMIN) counters, including:
  - chat: `chat.requests`, `chat.latency_ms_total`, `chat.intent_failure.*`, `chat.grounding.sanitized`, `chat.safety_urgent`, `chat.sensitive_data_redacted`, `chat.redteam.*`
  - LLM: `ai.llm.success|failure.{provider}.{reason}`, `ai.llm.circuit_open.*`, `ai.llm.latency_ms_total`, `ai.llm.tokens_in|out`
  - outbox: `outbox.claimed|published|retry|dead`
  - appointments: `appointments.requested|provider_confirmed|provider_failed|rescheduled|canceled`
  - CRM: `crm.tekion.enqueued`, `crm.tekion.gated.{reason}`
  - messaging: `messaging.queued|sent|suppressed.{reason}`, `messaging.webhook.bad_signature`
  - inventory: `inventory.hit|miss`
- **Business events:** `AnalyticsEvent` taxonomy (`conversation_start`, `message_sent`, `inventory_search`, `inventory_result`, `vehicle_view`, `payment_estimate`, `trade_submitted`, `finance_started`, `credit_link_offered|clicked`, `appointment_requested`, `service_appointment_requested`, `appointment_rescheduled|canceled`, `parts_request_submitted`, `lead_captured`, `handoff_requested`, `knowledge_hit|miss`) — no PII properties.
- **Dashboards:** Command Center Today (engagement / outcomes / technical / AI quality) and Integrations.
- **Health:** `/api/health/live`, `/api/health` (DB required; Redis degraded allowed), `/api/version`.
- **Logs:** structured Nest logs; use `redactForLog` for any external payload.

Next step when a metrics backend is chosen: export counters via OpenTelemetry (call sites unchanged).
