# ADF/XML lead delivery (per rooftop)

**Status: DEMO / sandbox only. Nothing here is LIVE VERIFIED.** No message has been sent to a
dealership mailbox, no recipient has been verified with a store's CRM admin, and no CRM has
parsed an AMQUR lead. The pipeline is built, gated off by default, and proven end to end against
a local sink and a loopback mock SMTP server.

## What it does

When a lead changes, AMQUR writes one `LeadDelivery` row and one outbox event in a single
transaction. The existing outbox worker then, for that delivery:

1. reloads the lead (tenant-scoped) and evaluates every gate;
2. resolves the destination strictly from the **lead's own** tenant + location + department;
3. builds an ADF 1.0 document, re-parses it with a hardened parser and checks the round trip;
4. hands the message to exactly one transport and records the typed receipt.

The existing JSON `crm.webhook` path (`CRM_WEBHOOK_URL`) is unchanged and independent.

| Piece | Location |
|---|---|
| Canonical DTO, serializer, validator | `src/integrations/adf/adf.types.ts`, `adf-serializer.ts`, `adf-validator.ts` |
| Lead row to DTO mapping | `adf-lead-mapper.ts` |
| Status ladder (one pure function) | `lead-delivery-state.ts` |
| Gates and env parsing (pure) | `lead-delivery-gates.ts` |
| Address normalisation, masking, fingerprint, header safety | `destination.ts` |
| Transports | `transports/sandbox-sink.transport.ts`, `transports/smtp.transport.ts` |
| Route registry (encrypted destinations) | `lead-delivery-route.service.ts` |
| Enqueue, outbox handler, replay, reconciliation | `lead-delivery.service.ts` |
| Operator API | `lead-delivery-ops.controller.ts` |
| Hook | `CrmSyncService.onLeadChanged` (`src/integrations/crm/crm-sync.service.ts`) |
| Migrations | `prisma/migrations/20261118100000_lead_delivery_adf`, `20261118120000_lead_delivery_mode` |
| Mock SMTP | `test-infra/mocks/mock-smtp.mjs` (compose service `mock-smtp`; failure modes `tempfail`, `reject`, `drop`, `slow`) |
| Consent standing from the ledger (pure) | `lead-consent-standing.ts` |
| Tests | `src/integrations/adf/*.spec.ts`, `test/suites/adf-lead-delivery.e2e-spec.ts`, `test/suites/adf-review-findings.e2e-spec.ts` |

## Data model

- `LeadDeliveryRoute`: one row per tenant + location + channel + department. The address is
  AES-256-GCM encrypted with the existing `SecretVaultService`; only a keyed HMAC fingerprint and
  a masked display (`l***@d***.net`) are stored in clear. Columns: `environment`
  (`SANDBOX`/`PRODUCTION`), `enabled`, `verified`, `verifiedAt`, `verifiedBy`,
  `verificationEvidence`, `productionEnabled`, `format` (`XML_BODY`/`XML_ATTACHMENT`),
  `adfVersion`. Everything defaults to off.
- `LeadDelivery`: one row per (lead, channel, destination) attempt chain. It holds no customer
  contact data and no raw address: `routeId`, fingerprint, masked display, `idempotencyKey`
  (unique per tenant), `status`, `attempts`, `replayCount`, `providerName`, `providerMessageId`,
  `providerRawStatus`, `crmRecordRef`, `payloadSha256`, `lastErrorCode`, per-status timestamps,
  `correlationId`.
- `LeadDeliveryEvent`: append-only status history with the evidence for each transition.

Invariants the database enforces, in addition to the application:

- composite FK `(routeId, tenantId)` to `LeadDeliveryRoute (id, tenantId)`: a delivery cannot
  reference another tenant's route;
- `productionEnabled` requires `verified` and `environment = PRODUCTION`;
- `verified` requires `verifiedAt`, `verifiedBy` and `verificationEvidence`;
- `CRM_MATCHED` requires `crmRecordRef`;
- `ACCEPTED` and every later state require a provider name, a provider message id, `acceptedAt`
  and a route.

## Status ladder

Each state needs its own evidence. They are never collapsed into "success".

| Status | Meaning | Evidence required |
|---|---|---|
| `QUEUED` | Row and outbox event written | The enqueue transaction |
| `SENT` | Handed to a transport; outcome not yet known | Handoff with an attempt number |
| `ACCEPTED` | Transport acknowledged (for SMTP: `250` plus a message id) | Provider name, message id, status line |
| `DELIVERED` | Provider reports delivery | Provider delivery callback only |
| `CRM_PARSED` | The CRM parsed the lead | Explicit reconciliation input |
| `CRM_MATCHED` | A CRM record exists for the lead | Explicit reconciliation input with a CRM record reference |
| `CRM_REJECTED` | The CRM parser rejected the lead | Explicit reconciliation input |
| `FAILED` | Retryable transport failure; outbox backoff retries | Retryable transport error code |
| `DEAD` | Permanent failure, attempts exhausted, or invalid payload | Error code; operator replay only |
| `BLOCKED` | A gate was closed; nothing was sent | Gate reason |

Rules (`transitionDelivery`):

- No skipping forward: `QUEUED` cannot become `ACCEPTED`, `SENT` cannot become `DELIVERED`, and
  nothing before `ACCEPTED` can be reconciled.
- SMTP acceptance is not delivery and not a CRM record. Plain SMTP has no delivery callback, so
  `DELIVERED` is unreachable today; reconciliation may follow `ACCEPTED` directly.
- A duplicate or late event for a state already reached or passed is a no-op. A late failure or
  block can never erase an acknowledgement.
- `CRM_REJECTED` and `CRM_MATCHED` are terminal.
- Only `FAILED`, `DEAD` and `BLOCKED` can be replayed, and only by an operator.
- A `SENT` row is another worker's attempt until it is stale (see "Idempotency and retries"). A
  stale `SENT` row can be handed off again **or** become `BLOCKED` when a gate has closed in the
  meantime; a fresh one is left alone and the outbox retries later (`delivery_in_flight`).
- No row is left non-terminal behind a dead outbox event: whatever an attempt throws, the final
  (8th) outbox attempt moves a `QUEUED` / `SENT` / `FAILED` row to `DEAD` with a PII-free code
  (`handler_error` when the failure has no code of its own), so it is visible and replayable.
  The one exception is a row whose send was accepted but not yet recorded
  (`accepted_record_pending`): it is finalised, never dead-lettered.

## Routing

- The route lookup is keyed by the lead row's `tenantId` + `locationId` + department (from
  `Lead.source`: `widget_service` is SERVICE, `widget_parts` is PARTS, everything else SALES).
- There is no default, catch-all, tenant-wide or group-wide recipient, and no CC/BCC path. A
  route holds exactly one bare mailbox.
- Unknown, disabled or unverified route: `BLOCKED` with the reason; the lead stays in AMQUR.
- Immediately before transport the handler re-checks that the route's tenant and location equal
  the lead's. CDJR South (`dial-cdjr-of-chicago`) and Jeep North (`jeep-of-chicago`) are separate
  tenants and can only ever resolve their own route.
- ADF is a sales lead format. SERVICE and PARTS leads need their own explicitly configured
  route; without one they are `BLOCKED: no_route`.

## Gates (all fail-closed)

A send happens only when every one of these is true:

1. `ADF_SEND_ENABLED=true` (default `false`);
2. the rooftop's feature flag `adfLeadDelivery` is on (default off; with it off no delivery row
   is created at all);
3. the lead has a contact method, is not marked spam, and the customer has not opted out of
   being contacted (resolved from the consent ledger at send time; see "Consent" below);
4. a route exists for the lead's tenant + location + department, and it is `enabled`;
5. the route is `verified`.

Transport selection:

- **Live** requires `NODE_ENV=production` and `LEAD_DELIVERY_MODE=live` and
  `ADF_SEND_ENABLED=true`, plus a `PRODUCTION` route that is `productionEnabled`. A reserved test
  domain is refused in live mode.
- **Production never uses a sandbox transport.** With `NODE_ENV=production` and live not fully
  gated on (for example `LEAD_DELIVERY_MODE` unset), the delivery is `BLOCKED:
  sandbox_in_production`; nothing is written to the sink or sent to any SMTP host. Both sandbox
  transports also refuse on their own in production. Production either sends live or sends
  nothing.
- **Outside production, anything that is not live is sandbox**, whatever the route says: the in-process sink
  (`ADF_SANDBOX_TRANSPORT=sink`, default) or the loopback mock SMTP (`smtp`). Sandbox SMTP
  additionally requires a loopback host and a reserved-domain recipient, so even a relaying MTA
  on localhost cannot reach a real mailbox.
- The SMTP transport itself refuses any non-loopback host unless live is fully gated on.
- `SANDBOX` routes may only point at reserved test domains and can never be production-enabled.
- `LeadDelivery.deliveryMode` (`sandbox` / `live`) records the mode of the latest transport
  hand-off and is shown in the operator API. A sandbox acknowledgement never counts as
  acknowledged in a live environment: on the next lead change, or on an operator replay, such a
  row is queued again (`sandbox_ack_superseded`; the sandbox receipt stays in the history) and
  then has to pass every live gate.

Environment-level blocks are re-evaluated automatically. Rows blocked for
`sandbox_in_production` or `send_disabled` are re-queued (`gate_reevaluation`) by a five-minute
sweep once the environment no longer blocks them; every other gate is then checked again by the
handler. The sweep does nothing while `ADF_SEND_ENABLED` is not `true`. Every other block reason
needs an operator replay.

Block reasons an operator can see: `send_disabled`, `flag_off`, `no_consent_basis`,
`no_contact_method`, `no_location`, `no_route`, `route_disabled`, `route_unverified`,
`route_tenant_mismatch`, `route_not_production_environment`, `route_not_production_enabled`,
`destination_unavailable`, `reserved_destination_in_live`, `sandbox_recipient_not_reserved`,
`smtp_host_not_loopback`, `sandbox_in_production`.

## Consent

The handler resolves the customer's standing from the append-only consent ledger
(`ConsentRecord`) every time it is about to send, including every operator replay
(`lead-consent-standing.ts`, pure). It looks up the lead's own normalised email and phone inside
the lead's own tenant; another rooftop's ledger never applies. Per channel (text = `SMS`,
email = `EMAIL`, call = `CALL`) the latest non-revoked record for that endpoint wins, and on an
exact timestamp tie the opt-out wins.

Handing a lead to the rooftop's own CRM is not a marketing send, so it does not need a marketing
grant. The hand-off is refused with `BLOCKED: no_consent_basis` only when the customer may not be
contacted at all:

1. `Lead.optOutAt` is set, or the lead is marked spam; or
2. the ledger holds an explicit do-not-contact / all-channel opt-out for one of the lead's
   endpoints (an opt-out record with `channel = ALL`, or evidence `doNotContact: true` /
   `scope: ALL`) with no later grant on that endpoint; or
3. every way the lead could be reached is opted out: the email, if the lead has one, has a
   standing `EMAIL` opt-out **and** the phone, if the lead has one, has standing opt-outs for
   **both** `SMS` and `CALL`.

An opt-out on a single channel while another contact channel remains (for example a text `STOP`
from a customer who also gave an email, or whose phone has no call opt-out) does **not** block
the hand-off. It is reported truthfully instead: that channel is `no` in the consent summary, the
phone is not typed `cellphone`, and it is never reported as consent whatever `Lead.consentTo*`
says. The rooftop's CRM is then responsible for honouring the per-channel `no`.

The consent summary in `<comments>` is `text=…, email=…, call=…` with `yes` (latest ledger record
is a grant, or no ledger record and the lead flag is set), `no` (latest ledger record is an
opt-out, or `Lead.optOutAt`), or `not recorded`.

Limits: nothing writes an all-channel do-not-contact record today (no staff or privacy flow
creates one), so rule 2 is exercised by tests only; `WHATSAPP` records are not summarised; the
ledger is matched by exact normalised endpoint, so a customer who opted out under a different
phone or email is not recognised.

## ADF document

`serializeAdf` is a pure, deterministic function of the DTO.

- Prolog `<?xml version="1.0" encoding="UTF-8"?>` and `<?adf version="1.0"?>`, then
  `<adf><prospect status="new">`.
- `<id sequence="1" source="AMQUR">amqur-lead-{leadId}</id>`, `<requestdate>` in ISO-8601 from the
  lead's creation time.
- `<vehicle interest status>` only for facts that are known. Year, make, model and trim come only
  from the rooftop's own inventory row for the lead's VIN. An unknown condition omits `status`; a
  lead with no known vehicle has no `<vehicle>` element.
- `<customer><contact>` with name parts, email and typed phone as provided.
- `<comments>`: a short structured note (department, requested action, preferred contact,
  appointment state, consent summary, source and UTM). Never the transcript. A requested
  appointment is worded "REQUESTED by customer - NOT confirmed"; only a `CONFIRMED` appointment
  with verified availability is worded as confirmed.
- `<vendor><vendorname>` is the rooftop's own name; `<provider><name>` is `ADF_PROVIDER_NAME`.
- Every text node and attribute is hand-escaped. Illegal XML characters, C1 controls, lone
  surrogates, bidi overrides and zero-width characters are stripped; text is NFC-normalised;
  fields are length-capped; the document has a hard byte cap (`ADF_MAX_BYTES`, default 64 KiB).
- `validateAdfRoundTrip` rejects DTDs, entity declarations, CDATA, non-predefined entities and
  control characters before parsing, checks well-formedness and required structure, and confirms
  the parsed values equal what the serializer meant to write. A failing document goes to `DEAD`
  and is never sent.

Not modelled: the lead mapper sends at most one vehicle of interest and does not map
`TradeRequest` into a trade-in vehicle. The serializer itself supports several vehicles and
`trade-in`, and is tested for them.

## Mail

Messages are built by nodemailer (MIT-0): `Message-ID`, `Date`, `From`, `To`, `Subject`,
`MIME-Version`, plus `X-AMQUR-Delivery-Id`, `X-AMQUR-Correlation-Id` and `Auto-Submitted`. The
subject carries the AMQUR lead reference only. `XML_BODY` sends the document as `text/plain`;
`XML_ATTACHMENT` attaches `lead.adf.xml` as `application/xml`. Every header-bound value is
rejected if it contains CR, LF or another control character.

The `Message-ID` is `<lead-delivery.{deliveryId}@{sender domain}>` and is stable across retries.

## Idempotency and retries

- Key: `lead-delivery:v1:{leadId}:ADF_EMAIL:{locationId}:{department}`, unique per tenant. This
  is the route's natural key, so it is deterministic per (tenant, lead, channel, route).
- Double submit, a later lead update, an outbox retry or a replay never create a second row. An
  acknowledged delivery is never handed to a transport again.
- Retryable failures (SMTP 4xx, connection, timeout) leave the row `FAILED` and use the existing
  outbox backoff; after 8 attempts the row is `DEAD`. Permanent failures (SMTP 5xx, bad address,
  invalid document) go straight to `DEAD`.
- Every hand-off has **one hard overall deadline** (`ADF_SEND_DEADLINE_MS`, default 30 s,
  maximum 60 s) covering connect, greeting, TLS, auth and DATA together. At the deadline the SMTP
  connection is aborted and the attempt is a retryable failure (`send_deadline_exceeded`); the
  handler enforces the same deadline around any transport. nodemailer's per-phase timeouts
  (8 s connect, 8 s greeting, 15 s idle socket) only bound idle phases and remain in place.
- A `SENT` row with no outcome is treated as a crashed attempt only after 90 s
  (`SENT_STALE_MS` = maximum deadline 60 s + 30 s margin), so a row cannot be reclaimed and
  re-sent while its own send is still inside its deadline. The 120 s outbox batch lease is
  longer than that window; if a lease expires under a long batch, the second worker finds the
  row `SENT` and fresh and backs off (`delivery_in_flight`).
- One ADF message is sent per lead. Later lead updates are not re-sent.
- Delivery is **at-least-once, not exactly-once**. The guarantee is: an *acknowledged* delivery
  is never handed to a transport again. It is not "at most one accepted send" in every failure.
- After a transport accepts, the handler never marks the row `FAILED` and never re-sends because
  of a failure to *record* the acknowledgement:
  1. the `ACCEPTED` write (row + history, one transaction) is retried three times;
  2. a lost compare-and-set is resolved against the row's current state: already acknowledged is
     a no-op; a row another attempt had marked `FAILED`/`DEAD` becomes `ACCEPTED` with
     `late_transport_receipt` evidence; any other state keeps the receipt in the history
     (`accepted_receipt_unapplied`);
  3. if the write still fails, the receipt is stored on the `SENT` row in one statement with
     `lastErrorCode = accepted_record_pending`. The stale-`SENT` reclaim skips such rows; the
     outbox retry finalises them to `ACCEPTED` from the stored receipt without a transport call;
  4. if even that statement fails (database unreachable), the receipt is kept in the worker's
     memory and the next attempt in that process finalises from it.
- Remaining duplicate window: the worker process dies after the transport accepts and before any
  of the writes above commits (or the database is unreachable *and* the process restarts). The
  stale `SENT` row is then retried with the same `Message-ID`, so a receiver can de-duplicate.
- If the outbox event exhausts its attempts while a row is `accepted_record_pending`, the row
  stays `SENT` with that code (it is not `DEAD`, because replay would re-send). Replaying the
  outbox event finalises it.

## Privacy

- The outbox payload is `{ deliveryId }` only.
- Logs, outbox errors, status history and metrics carry ids and codes only. Provider status lines
  are stripped of anything address-like before they are stored.
- Destination addresses never appear in any API response. Operator responses show the masked
  display only; public and widget endpoints show nothing.
- In production the sandbox sink refuses every message (`sandbox_in_production`); it stores nothing.

## Operator API

Staff only, tenant-scoped from the JWT, confined to the caller's rooftop when the user is bound
to a location. Another tenant's delivery is a 404.

| Method | Path | Roles |
|---|---|---|
| GET | `/api/ops/lead-deliveries?status=&locationId=` | all staff |
| GET | `/api/ops/lead-deliveries/:id` (with status history) | all staff |
| POST | `/api/ops/lead-deliveries/:id/replay` | SUPER_ADMIN, ADMIN |
| POST | `/api/ops/lead-deliveries/:id/reconcile` | SUPER_ADMIN, ADMIN, MANAGER |
| GET | `/api/ops/lead-delivery-routes` (masked) | SUPER_ADMIN, ADMIN, MANAGER |

`reconcile` body: `{ "result": "CRM_PARSED" | "CRM_MATCHED" | "CRM_REJECTED", "crmRecordRef"?, "note"? }`.
`CRM_MATCHED` requires `crmRecordRef`. Replay and reconcile write `AuditLog`
(`lead_delivery.replay`, `lead_delivery.reconciled`). Route changes write
`lead_delivery_route.*`.

There is deliberately no HTTP endpoint that creates, verifies or production-enables a route.
Those are server-side calls on `LeadDeliveryRouteService` only.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `ADF_SEND_ENABLED` | `false` | Master switch |
| `LEAD_DELIVERY_MODE` | `sandbox` | `live` only takes effect in production with the switch on |
| `ADF_SANDBOX_TRANSPORT` | `sink` | `sink` or `smtp` (loopback only) |
| `ADF_SMTP_HOST` / `ADF_SMTP_PORT` | `127.0.0.1` / `11025` | SMTP relay; required when mode is `live` |
| `ADF_SMTP_SECURE`, `ADF_SMTP_USER`, `ADF_SMTP_PASS` | off / unset | Relay TLS and credentials |
| `ADF_FROM_ADDRESS` | `adf-sandbox@amqur.example.invalid` | Sender; required when mode is `live` |
| `ADF_PROVIDER_NAME` | `AMQUR AI` | `<provider><name>` |
| `ADF_MAX_BYTES` | `65536` | Hard cap on one document |
| `ADF_SEND_DEADLINE_MS` | `30000` | Hard overall deadline for one hand-off (250–60000) |
| `ADF_SANDBOX_SINK_DIR` | unset | Optional local `.eml` directory (never in production) |

## Sandbox demo

```bash
npm run test:infra:up
set -a && . ./test-infra/.env.test && set +a
npx prisma migrate deploy
npm run adf:sandbox-demo              # in-process sink
npm run adf:sandbox-demo -- --smtp    # loopback mock SMTP; inspect http://127.0.0.1:18085/messages
npm run test:infra:down
```

The demo refuses a non-local database and `NODE_ENV=production`. It creates the five rooftop
tenants locally, gives each a `SANDBOX` route to its own `*.example.invalid` address, creates one
synthetic lead per rooftop and prints where each landed.

`config/rooftops/lead-recipient-candidates.json` lists the operator-supplied candidate inboxes,
masked, every one `verified:false, productionEnabled:false`. Nothing reads it to send.

## What remains BLOCKED

| Item | Why it is blocked | What unblocks it |
|---|---|---|
| Recipient verification | Candidate addresses are historical operator context, not confirmed inbound lead inboxes | Each store's CRM admin confirms the address in writing; record it as `verificationEvidence` |
| Body vs attachment | Unknown which variant each store's parser expects, or whether it accepts quoted-printable bodies and a prospect with no `<vehicle>` | A test import per store, then set `format` on the route |
| Sender authentication | No sending domain, SPF, DKIM or DMARC is set up; no relay is chosen | Choose a relay and sender domain, publish DNS records, set `ADF_FROM_ADDRESS` |
| Delivery callback | Plain SMTP gives no delivery or bounce signal, so `DELIVERED` cannot be reached | A relay with signed delivery webhooks and an inbound endpoint for them |
| Tekion reconciliation source | No approved Tekion API scope; `CRM_PARSED` / `CRM_MATCHED` are manual operator inputs | An approved Tekion read scope or an agreed export from the store |
| Route administration over HTTP | Not built on purpose | A release gate for who may verify and production-enable a route |
| Live send | Never exercised | All of the above, then a per-store canary |
