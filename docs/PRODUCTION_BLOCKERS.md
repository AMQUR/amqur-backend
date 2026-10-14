# Production blockers (external only)

Last verified: 2026-10-13 (engineering completion pass on branch `feat/production-completion-2026-10`).

Every item below is something the **dealership, a vendor, or the platform owner must supply or approve**. The code paths are built, tested, and fail closed until the artifact exists. Nothing here is an engineering TODO.

Secrets are never placed in Git or in this file. "Vault" below means the encrypted `IntegrationSecret` store (set through the Integration Center / operator script) or the Railway service variables, as stated.

---

## B-01 — Tekion partner access (CRM writeback, scheduling, RO status, parts)

| Field | Value |
|---|---|
| Capability | Tekion CRM lead upsert / activity append; appointment availability / create / update / cancel; repair-order read; parts catalog / inventory / order |
| Tenant / location | Every rooftop on Tekion (first: Jeep of Chicago) |
| Why blocked | No official Tekion partner API specification, sandbox, or credentials exist in this repository or environment. Endpoints may not be guessed or reverse-engineered. |
| Exact artifacts required | (1) Tekion partner agreement + **official API specification** for each capability; (2) sandbox base URL + OAuth/client credentials; (3) per-rooftop dealer ID / store ID mapping; (4) webhook signing specification if events are used; (5) production credentials after sandbox contract tests pass |
| Who provides | Dealer group IT / Tekion partner program (GitHub issue AMQUR/amqur-backend#6) |
| Where configured | `IntegrationConnection` (provider `TEKION`, capability `crm` / `appointments`), `config = { environment, apiBaseUrl, dealerId, storeId, contractVerifiedAt, contractVersion, capabilities{…} }`; credentials in the vault (`clientId`, `clientSecret`) |
| Security handling | Credentials encrypted AES-256-GCM (`INTEGRATION_ENCRYPTION_KEY`); never logged; adapter refuses all operations until `isLiveConfigured()` |
| Engineering remaining once supplied | Implement `TekionHttpClient` strictly from the official spec inside the existing adapter boundary (`src/integrations/tekion/tekion.provider.ts`) and run the contract suite against the sandbox. All gating, outbox, idempotency, health, Command Center surfaces, and business flows are complete. |
| Test afterwards | Contract suite vs. sandbox; `GET /api/ops/integrations` shows capability matrix + `writebackGate.open: true`; journey e2e with scheduler adapter returning `confirmed` |
| Feature flag | `tekionIntegration` (tenant) + per-capability declaration in connection config |
| Code otherwise complete | Yes (fail-closed adapter, capability model, gate, writeback worker, UI). The HTTP client is intentionally absent until the spec exists. |

## B-02 — Authorized live inventory feed (vAuto / DMS / normalized feed)

| Field | Value |
|---|---|
| Capability | Customer-visible inventory search, pricing, payment estimates |
| Tenant / location | Each rooftop (first: Jeep of Chicago) |
| Why blocked | No authorized production feed. Fixture inventory is never customer inventory. |
| Exact artifacts | vAuto (or DMS) feed authorization for the rooftop; feed URL or SFTP/API credentials; rooftop ↔ feed ID mapping; agreed refresh cadence |
| Who provides | Dealer group / vAuto account owner (issue AMQUR/amqur-backend#7) |
| Where configured | `Location.inventoryFeedUrl` + `INVENTORY_FEED_ALLOWED_HOSTS`, or `IntegrationConnection` (provider `VAUTO` / `NORMALIZED_INVENTORY_HTTP`) |
| Security | Feed host allowlist + SSRF guard; anomaly rejection keeps last-known-good |
| Test afterwards | Import run shows `validCount>0`, no anomalies; Command Center inventory freshness `FRESH`; `inventory` capability passes chain check |
| Feature flags | `inventory`, then `payments` + `financeCalculator` |
| Code complete | Yes |

## B-03 — Verified store data per rooftop (hours, holidays, department hours, address/phone, service amenities)

| Field | Value |
|---|---|
| Capability | Hours answers, open/closed badge, appointment validation, quiet hours, amenity answers |
| Why blocked | Hours are customer-visible **only** after staff verification; no verified values recorded for production rooftops |
| Exact artifacts | Weekly sales/service/parts hours, holiday closures for the next 12 months, timezone, shuttle/loaner policy |
| Who provides | Rooftop general manager / service manager |
| Where configured | Command Center → Rooftop settings (sets `storeHoursVerifiedAt` with the verifying user) |
| Test afterwards | `GET /api/public/store-status` returns `known: true`; "what time do you close?" answers with the hours card |
| Code complete | Yes |

## B-04 — Human handoff destination

| Field | Value |
|---|---|
| Capability | Notifying staff when a customer asks for a person (beyond the Command Center inbox) |
| Why blocked | No verified CRM/ADF/webhook destination; staging `CRM_WEBHOOK_URL` absent (issue AMQUR/amqur-backend#8) |
| Exact artifacts | Verified receiving endpoint (dealer CRM ADF email-to-lead or HTTPS webhook), business-hours and after-hours owners, SLA |
| Where configured | `CRM_WEBHOOK_URL` + `CRM_WEBHOOK_SIGNING_SECRET` (Railway variables) and/or Command Center staffing |
| Behavior until then | Escalations are persisted and shown in the Command Center; the assistant says it **cannot confirm** anyone was notified |
| Code complete | Yes |

## B-05 — Dealership-approved credit application destination

| Field | Value |
|---|---|
| Capability | "Send me the credit application" secure handoff |
| Exact artifacts | HTTPS URL of the dealership's approved credit application, its hostname(s), provider name; written approval |
| Where configured | Command Center → Rooftop settings → Secure credit application (allowlist enforced) |
| Behavior until then | Assistant offers a finance-team follow-up instead |
| Code complete | Yes |

## B-06 — Payment estimate tax/fee rules (optional)

Without dealer-verified tax rate, basis, documentation fee and other mandatory fees, estimates are labeled **illustrative and exclude taxes/fees**. To include them: Rooftop settings → Payment estimate policy with "verified" checked. Code complete.

## B-07 — SMS / WhatsApp sender (Twilio)

| Field | Value |
|---|---|
| Capability | Text continuation, appointment reminders, campaign messages, inbound SMS |
| Exact artifacts | Twilio account SID, auth token, Messaging Service SID; A2P 10DLC brand + campaign registration (or toll-free verification); approved sender number(s); Advanced Opt-Out configured; consent wording approved by dealer counsel |
| Who provides | Platform owner (purchase/registration is a paid third-party action — not performed by engineering) |
| Where configured | `IntegrationConnection` (provider `TWILIO`, capability `messaging`, `liveReady`) + vault keys `accountSid`, `authToken`, `messagingServiceSid`; `PUBLIC_API_URL`; Twilio webhook URLs `…/api/webhooks/twilio/{tenantSlug}/sms` and `/status`; flag `sms` |
| Test afterwards | `test/suites/messaging.e2e-spec.ts` against the sandbox; send to an internal consented number; STOP from that number revokes consent |
| Code complete | Yes |

## B-08 — Email provider

Transactional/conversational email is **not activated**. Required: provider choice (e.g. SendGrid/Postmark/SES), verified sending domain (SPF/DKIM/DMARC), API key, inbound parse domain if replies are desired. The consent ledger and outbound tracking already support `EMAIL`; an `EmailProvider` adapter must be added against the chosen provider's official API once selected. **This is the one remaining item that is partly engineering** (adapter for a not-yet-chosen vendor) — see "Deliberately deferred" below.

## B-09 — Voice provider / number / routing

Voice is disabled. Required: telephony provider + number(s), call-routing tree per department, recording/consent policy approval, operational review. `VoiceCallSession` model and provider contract exist; no public voice without these.

## B-10 — Website installation authorization

| Field | Value |
|---|---|
| Exact artifacts | Write access to the dealer site (GTM container, TeamVelocity/Apollo pixel, or website vendor) **and** written approval to publish; exact production origins (www/non-www) |
| Where configured | `Tenant.allowedOrigins` (exact origins, no wildcards); tag manager / vendor |
| Current state | Apollo pixel saved **disabled**; GTM container not accessible (see `docs/EXTERNAL_AUTHORIZATION_REQUIRED.md`) |

## B-11 — Database backup / restore verification

| Field | Value |
|---|---|
| Why blocked | Could not verify Railway Postgres backup schedule/retention or perform a restore drill from this session: the local Railway CLI session is expired and engineering must not log in on the owner's behalf |
| Exact artifacts | Railway plan confirmation that scheduled backups/PITR are enabled for the production Postgres; retention period; a completed **non-production restore drill** with evidence (see `docs/BACKUP_AND_RESTORE.md`) |
| Who | Platform owner (Railway workspace admin) |

## B-12 — Production error monitoring DSN

`ERROR_MONITORING_DSN` (Sentry-compatible) is not confirmed for production. Instrumentation is complete (`src/observability/instrument.ts`); supply the DSN as a Railway variable.

## B-13 — Durable upload storage

Production uploads fail closed while `UPLOAD_STORAGE=local` (container disk is ephemeral). Required: S3-compatible bucket, credentials, lifecycle policy, malware-scanning service (e.g. bucket-native scanning). A storage/scanner adapter for the chosen vendor is required — like B-08 this depends on a vendor choice.

## B-14 — Employee canary approval and public release approval

Required: named employee testers and rollback owner (canary), then the signed production release approval for Jeep of Chicago (issue AMQUR/amqur-backend#20). Engineering approval is not dealership authorization.

## B-15 — Production secrets confirmation

Production now **fails to boot** without `CORS_ORIGINS` and `INTEGRATION_ENCRYPTION_KEY` (intentional). Confirm on the production service before the next production deploy, together with a distinct `WIDGET_TOKEN_SECRET`, `CONVERSATION_ID_SECRET`, `CREDIT_LINK_SIGNING_SECRET`, and `STAFF_MFA_REQUIRED_ROLES` (defaults to `SUPER_ADMIN,ADMIN`).

---

## Deliberately deferred (vendor not yet chosen)

These require choosing a third-party vendor before an adapter can be written against its official API. Interfaces, consent/outbox plumbing, gating and UI states are in place:

- Email provider adapter (B-08)
- Object storage + malware scanner adapter (B-13)
- Voice/telephony adapter (B-09)
- Third-party appraisal (trade) provider, finance (lender/credit decision) provider, parts catalog provider other than Tekion
