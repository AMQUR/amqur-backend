# Production blockers (external only)

Last verified: 2026-10-14 (engineering completion pass on branch `feat/production-completion-2026-10`).

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

## B-05 — Dealership-approved credit application destination (Tekion)

| Field | Value |
|---|---|
| Capability | "Where's the credit application?" → secure Tekion handoff card |
| Current state (2026-10-14) | Owner supplied a candidate `consumer-credit.tekioncloud.com/creditApplication?token=…` URL. It is stored **AES-256-GCM encrypted** in the local demo database only, link type **UNVERIFIED**, shown as a labeled **demo preview** (click lands on an AMQUR interstitial; never navigates to or consumes the token). Not configured on any shared environment. |
| Why blocked | No official Tekion documentation available to us states whether this token is a public reusable link, a dealership-reusable link, or a per-customer session link. Rooftop mapping and written dealership authorization for each of the five rooftops are not on record. |
| Exact artifacts | (1) Tekion's written confirmation of the link type and validity period; (2) which rooftop(s) the link belongs to; (3) dealership written approval per rooftop (reference recorded as `evidenceRef`); (4) if per-customer: Tekion's official API contract + credentials for link issuance; (5) whether the token should be rotated since it was shared in a chat transcript |
| Where configured | Command Center → Rooftop settings → Secure credit application, or `PUT/POST /api/ops/locations/:id/credit-application/{destination,authorize,disable}` (URL write-only, never returned) |
| Behavior until then | Production: assistant offers a finance-team follow-up. Non-production demo: labeled preview card. |
| Code complete | Yes (vault storage, link types, per-location authorization, rotation clears authorization, `PER_CUSTOMER` fails closed behind `CreditLinkProvider`) |

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

## B-16 — pgvector availability (semantic knowledge search)

Embeddings are stored as JSON arrays; the local Postgres 16 image has no `vector` extension and Railway Postgres could not be checked (B-19). Needed: confirm `CREATE EXTENSION vector` is permitted on staging/production Postgres; then an additive migration moves embeddings to `vector` with an index. Keyword + JSON-embedding hybrid retrieval works meanwhile.

## B-17 — Trade-in valuation licensing

All candidate providers (vAuto, Manheim MMR, CARFAX History-Based Value, KBB, Black Book, ACV/ClearCar) are `NOT_LICENSED`; CARFAX history access is not valuation rights. Needed: chosen provider, API contract, and written **consumer-display** rights. Until then customers see a value only when a manager issues an offer in the Command Center.

## B-18 — Legal review of pricing and fee handling (Illinois)

Doc-fee cap and its inclusion in advertised prices, tax basis, and OTD disclosure wording need dealership counsel sign-off. Public sources found disagree on the current Illinois doc-fee cap and none is official, so no cap is hard-coded; staff enter verified values. Federal context: FTC CARS Rule vacated (5th Cir., 2025-01-27); FTC Act Section 5 still applies.

## B-19 — Railway access for staging verification

Railway CLI session expired (`invalid_grant`). Needed: owner re-login or a scoped project token to verify staging deploys, backups (B-11), monitoring (B-12) and pgvector (B-16).

## B-20 — Website identity/provider confirmation for three stores

dialnissan.com, infinitichicago.com and dialjeep.com returned HTTP 403 to a read-only homepage check (bot protection, not bypassed). Provider, origins and public identity must come from the dealership or provider (see `docs/EXTERNAL_REQUESTS.md` §4).

---

## Deliberately deferred (vendor not yet chosen)

These require choosing a third-party vendor before an adapter can be written against its official API. Interfaces, consent/outbox plumbing, gating and UI states are in place:

- Email provider adapter (B-08)
- Object storage + malware scanner adapter (B-13)
- Voice/telephony adapter (B-09)
- Third-party appraisal (trade) provider, finance (lender/credit decision) provider, parts catalog provider other than Tekion
