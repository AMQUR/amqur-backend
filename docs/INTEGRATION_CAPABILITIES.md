# Integration capabilities

| Provider | Implemented | Configured (prod) | Tested | Live | Enabled by | Reason if disabled |
|---|---|---|---|---|---|---|
| Tekion CRM / scheduling / RO / parts | Capability model, gate, writeback worker, Command Center; HTTP client pending official spec | No | Contract fixture + fail-closed tests | No | `tekionIntegration` flag + verified connection config | B-01 |
| vAuto / normalized inventory feed | Yes (ingestion, anomaly guard, last-known-good) | No (prod) | Yes | No | `inventory` flag + feed | B-02 |
| Generic CRM webhook (ADF/JSON receiver) | Yes (outbox, HMAC signing, DLQ) | Staging: absent | Yes (mock CRM) | No | `CRM_WEBHOOK_URL` | B-04 |
| Twilio SMS / WhatsApp-ready | Yes (REST, signatures, STOP/START/HELP, status) | No | Yes (fake Twilio e2e) | No | `sms` flag + TWILIO connection | B-07 |
| Email | Consent + outbound model only | No | — | No | vendor choice | B-08 |
| Voice | Session model + contract | No | — | No | vendor + review | B-09 |
| Google Calendar | Scheduling registry supports it as explicit fallback only | No | Registry ranking tests | No | `appointments` connection | Not needed when DMS scheduler exists |
| Anthropic / OpenAI | Router, timeouts, shared breaker, PII egress redaction | Staging per env | Yes | Staging only if key set | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | — |
| Error monitoring (Sentry-compatible) | Yes | Unknown | — | — | `ERROR_MONITORING_DSN` | B-12 |
| Object storage / malware scan | Interface + fail-closed | No | Local tests | No | `UPLOAD_STORAGE=s3` + adapter | B-13 |

All provider health is visible at Command Center → Integrations (`GET /api/ops/integrations`). Credentials are displayed only as "configured / missing".
