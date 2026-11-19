# Integration capabilities

| Provider | Implemented | Configured (prod) | Tested | Live | Enabled by | Reason if disabled |
|---|---|---|---|---|---|---|
| Tekion CRM / scheduling / RO / parts | Capability model, gate, writeback worker, Command Center; HTTP client pending official spec | No | Contract fixture + fail-closed tests | No | `tekionIntegration` flag + verified connection config | B-01 |
| vAuto / normalized inventory feed | Yes (ingestion, anomaly guard, last-known-good) | No (prod) | Yes | No | `inventory` flag + feed | B-02 |
| Generic CRM webhook (ADF/JSON receiver) | Yes (outbox, HMAC signing, DLQ) | Staging: absent | Yes (mock CRM) | No | `CRM_WEBHOOK_URL` | B-04 |
| ADF/XML lead delivery by email, per rooftop | Yes: serializer, hardened validator, per-rooftop encrypted routes, outbox worker, status ladder, sandbox sink and SMTP transports, operator API. See `docs/ADF_LEAD_DELIVERY.md` | No. No route exists outside local sandboxes; no sender domain or relay | Unit + e2e against the local sink and a loopback mock SMTP only. **DEMO / sandbox** | No. Nothing LIVE VERIFIED: no recipient verified, no real mailbox addressed, no CRM import seen | `ADF_SEND_ENABLED` + `adfLeadDelivery` flag + verified route; live also needs `LEAD_DELIVERY_MODE=live` in production and a production-enabled route | Recipient verification, parser variant, SPF/DKIM/DMARC, reconciliation source |
| Twilio SMS / WhatsApp-ready | Yes (REST, signatures, STOP/START/HELP, status) | No | Yes (fake Twilio e2e) | No | `sms` flag + TWILIO connection | B-07 |
| Email | Consent + outbound model only | No | — | No | vendor choice | B-08 |
| Voice | Session model + contract | No | — | No | vendor + review | B-09 |
| Google Calendar | Scheduling registry supports it as explicit fallback only | No | Registry ranking tests | No | `appointments` connection | Not needed when DMS scheduler exists |
| Anthropic / OpenAI | Router, timeouts, shared breaker, PII egress redaction | Staging per env | Yes | Staging only if key set | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | — |
| Error monitoring (Sentry-compatible) | Yes | Unknown | — | — | `ERROR_MONITORING_DSN` | B-12 |
| Object storage / malware scan | Interface + fail-closed | No | Local tests | No | `UPLOAD_STORAGE=s3` + adapter | B-13 |

All provider health is visible at Command Center → Integrations (`GET /api/ops/integrations`). Credentials are displayed only as "configured / missing".

## Feature flags (audited 2026-10-13)

| Flag | Semantics | Dependency checked by |
|---|---|---|
| `chat` | Widget conversation on/off (kill switch) | CapabilityService |
| `inventory` | Inventory tools | + fresh vehicles / feed chain |
| `payments` + `financeCalculator` | Payment estimates | + inventory capability |
| `vehicleCompare`, `savedVehicles` | Widget features | + inventory (compare) |
| `appointments` | Appointment requests (sales/test drive/service) | — |
| `serviceAi`, `partsAi` | Service / parts flows | + `appointments` for booking |
| `leadCapture`, `handoff` | Lead + finance/trade capture, escalations | — |
| `knowledge` | Customer knowledge retrieval | published CUSTOMER docs |
| `uploads` | Staff uploads | durable storage in production |
| `sms` | Outbound/inbound SMS | live-ready Twilio connection + consent |
| `automatedFollowup` | Kill switch for all campaigns (plus per-campaign enable) | `sms` |
| `adfLeadDelivery` | Queue per-rooftop ADF/XML lead deliveries (default off) | a send also needs `ADF_SEND_ENABLED` and an enabled, verified `LeadDeliveryRoute` |
| `tekionIntegration` | Tekion writeback | forced off without live-ready connection + verified contract |
| `proactiveEngagement`, `multilingual`, `copilot` | Widget nudges / language toggle / staff copilot | — |
| **Reserved (forced off)** `voiceAi`, `whatsapp`, `email`, `priceDropAlerts`, `crossStoreInventory` | Visible roadmap only; setting true has no effect | `FeatureFlagsService.explain()` returns reason codes |

Removed: `vAutoFeed`, `leadScoring` (no consumers; implied functionality that did not exist).
