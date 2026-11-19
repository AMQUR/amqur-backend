# Chat stream and sales-desk card contract (server half)

Server side of the widget ↔ backend contract for streaming replies and structured cards.
The widget side lives in `amqur-widget` (`src/widget/api/chat.api.ts`,
`src/widget/concierge/types.ts`). Everything here is **additive**: a client that sends none
of the new fields and a tenant with `salesDeskCards` off get exactly the previous
`POST /api/chat` behaviour.

Status: built and tested locally (unit + platform e2e). Not deployed anywhere. The only
scheduler behind it is a labelled **sandbox** — see "What is sandbox-only".

## 1. `POST /api/chat/stream`

Same request body, auth (widget JWT, origin binding), throttle bucket, validation and
conversation-id rules as `POST /api/chat`, and the same engine call — only the delivery
differs.

- Response: `200`, `Content-Type: text/event-stream; charset=utf-8`,
  `Cache-Control: no-store`, `X-Accel-Buffering: no`. No JSON envelope.
- Failures **before** the stream starts (401/403 auth or origin, 400 validation, 429) are the
  ordinary JSON error responses. A client should treat `404`/`405` or a non-SSE `200` as "no
  stream support" and fall back to `POST /api/chat`.
- Frames: `event: <type>\ndata: <one JSON object>\n\n`. Unknown `type`s must be ignored.

| Order | Event | Fields |
|---|---|---|
| 1 | `turn.started` | `turnId`, `conversationId?` (widget traffic), `conversationIdIssued?` |
| 0..n | `status` | `phase: 'thinking' \| 'checking' \| 'composing'`, `label?` (customer language) |
| per segment | `text.delta` then `text.done` | `index`, `text` (delta only) |
| last | `turn.completed` | `response` — exactly what `POST /api/chat` returns in `data`, including `conversationId` |
| instead of the above, after a failure | `turn.error` | `code` (`turn_failed`), `message` (short, customer-safe), `retryable` — then the stream ends |

Honest streaming rules:

- The engine composes a reply as a whole, so each **segment is sent once, when it exists**
  (`text.delta` carries the full segment). There is no token-by-token typing and no injected
  delay.
- `status` is only emitted for work that is really starting: `checking` / "Checking
  inventory" before an inventory read, `checking` / "Checking with the scheduler" before a
  slot booking, `composing` when the language model composes. `thinking` is reserved and not
  emitted today.
- `turn.error` never carries an exception message, stack or internal detail.
- Client disconnect: writes stop, nothing throws, and the turn **still runs to completion**;
  messages and conversation state are persisted exactly as for a connected client.

## 2. Request additions (`POST /api/chat` and `/api/chat/stream`)

`action` gains `appointment_select`. Two optional objects, strictly validated (whitelist,
bounded lengths; unknown fields → 400):

```jsonc
// only with action: "lead_capture"
"lead": {
  "formId": "lf_…",               // the lead_form card's id
  "firstName": "…", "lastName": "…",   // 1–60 chars each
  "email": "…", "phone": "…",          // optional
  "preferredChannel": "EMAIL" | "CALL" | "TEXT",
  "consents": [{ "channel": "EMAIL", "granted": true, "version": "lead-form-consent-v1" }]
}
// only with action: "appointment_select"
"appointment": {
  "pickerId": "pk_…",
  "slotId": "sl_…",                    // provider_slots mode
  "requestedDate": "yyyy-mm-dd",       // request_only mode, with requestedWindow
  "requestedWindow": "morning" | "afternoon" | "evening"
}
```

`lead` with any other action, or `appointment` with any other action, is a 400. There is no
field for SSN, date of birth, income or bank details, and none is accepted. Tenant and
location always come from the authenticated token — never from the body.

A structured submission is stored in the transcript as a neutral marker
(`[contact details submitted]` / `[appointment time selected]`); `message` is ignored for it.

## 3. Cards (flag `salesDeskCards`, default off)

Cards ride along with the engine's existing text question, which stays as the text-only
fallback (typing an answer still works).

### `lead_form` — attached when the engine asks for a name / contact method

`{ kind, id, purpose: 'sales'|'test_drive'|'service'|'parts'|'callback', rooftopName,
vehicleLabel, vin, channels, consent: { version, text: { EMAIL?, CALL?, TEXT? } }, reason }`

- `channels`: `EMAIL` and `CALL` always (how staff already follow up); `TEXT` only when the
  `sms` capability is on for that tenant/location.
- `consent`: server-side constant `lead-form-consent-v1` (EN/ES) in
  `src/chat/sales-desk/consent-wording.ts`. Changing wording requires a new version.
- An unanswered form keeps its `id` when re-offered.

Submission rules (server-side; the client is never trusted):

- The form must be the one this conversation was offered; names required; email format; US
  phone = 10 digits; the preferred channel must be offered, have its contact detail, and be
  `granted: true` against a recognised version.
- Otherwise **nothing is stored** (no contact, no consent row, no lead), a one-line reason is
  given and the form is offered again.
- On success: one append-only `ConsentRecord` per channel the customer ticked (purpose
  `CONVERSATIONAL`, source `WIDGET`, exact wording + version, evidence
  `{capturedVia:'lead_form', formId, …}`, tenant + location scoped). Nothing is recorded as
  granted that was not ticked, and an un-ticked box is **not** recorded as an opt-out. A
  contact detail is kept only when a granted channel covers it. Contact then goes through
  the same state, propagation (`handleContact`) and lead sync as the conversational path, so
  the existing outbox/CRM hooks fire. A repeat submit of the same form is a no-op.

### `appointment_picker` — attached when the engine asks for a day / time

`{ kind, id, department: 'sales'|'service', purpose, rooftopName, timezone, mode,
days?, slots?: [{ id, start, end, expiresAt }], vehicleLabel, vin, sandbox? }`

| `mode` | When | Selecting |
|---|---|---|
| `request_only` | No authorised scheduler (every real rooftop today), or an existing request is being moved | `requestedDate` (one of `days`) + `requestedWindow` → the existing request path → `REQUESTED`; card `outcome: 'requested'`, `verified: false`, no provider fields |
| `provider_slots` | The scheduling registry resolves an adapter for this tenant/location/department (enabled + liveReady connection, registered adapter, gates passed) that can read availability and book, **and** the customer's contact is known | `slotId` → booked through the adapter |
| `external_link` | **Not implemented.** No per-location scheduler URL exists in server configuration, and one is never invented | — |

- `days`: the next five calendar days in the store timezone starting tomorrow; closed days
  are skipped only when the location's hours are verified. No business hours are implied
  beyond morning/afternoon/evening.
- When real slots would be offered but the customer is unknown, the engine asks for contact
  first (lead form), then resumes with the picker. Without a scheduler the engine's own order
  stands: request first, contact afterwards.
- A slot selection is verified against what **this conversation** was offered, for **this**
  rooftop, within the 15-minute offer window; anything else is refused ("…nothing was
  booked") with a fresh picker. Booking is idempotent per (conversation, picker, slot).
- **One active appointment per kind and conversation** (sales visit / test drive are one kind,
  service another). Once a slot booking is saved, every remembered `provider_slots` picker of
  that kind is spent: only the booked slot stays in conversation state, and submitting it again
  is an idempotent replay that returns the same `appointment` card. Any **other** slot — from
  the same card or an older one — books nothing: the reply says what already exists ("You
  already have a test drive booked for …, so nothing new was booked. Do you want to change
  it?") and the existing change flow is offered (a `request_only` picker; choosing a day moves
  the request and is confirmed by staff). The same guard applies when the earlier appointment
  was made by typing. If the existing appointment has since been cancelled, the spent card is
  refused ("…nothing new was booked") and a fresh picker is offered.

### `appointment` — extended (new fields only with the flag on)

Existing fields unchanged. Added: `rooftopName`, `department` (localised), `timezone`, and —
**only with a provider confirmation** — `providerRef`, `providerName`, `startsAt`,
`sandbox?`.

- `outcome: 'confirmed'` / `verified: true` / status `CONFIRMED` are produced in chat only
  from an adapter receipt: the appointment is confirmed in the same transaction that inserts
  a `CONFIRMED` `AppointmentProviderReceipt` (`providerRef` unique per tenant + provider).
  Every provider response writes one receipt row (`CONFIRMED`, `PENDING`, `UNAVAILABLE`,
  `FAILED`, `CONFLICT`). (Staff can still confirm a request by hand in the Command Center;
  that path is unchanged and writes no provider receipt.)
- Provider says no / lost race → "That time was just taken, so nothing was booked." plus a
  fresh picker; the attempt is recorded `CANCELLED` + `UNAVAILABLE` receipt.
- Provider error / timeout → the request stays `REQUESTED` (`outcome: 'requested'`,
  `FAILED` receipt) for staff to confirm. Never a confirmation.

### `Vehicle` — additive fields (same flag)

- `rooftopName`: display name of the location that holds the vehicle (null if none).
- `vdpUrl`: only an https URL present in the vehicle's feed record whose host is the owning
  rooftop's own website host; otherwise `null`. Never constructed. **No feed writes such a
  URL today, so this is always `null`.**
- `priceIncludesDealerFees`: `true`/`false` only from the dealer-configured pricing policy
  of the conversation's rooftop; `null` when the policy does not say (the default).

### Branding

`GET /api/public/widget-config` → `branding.theme`: `'neutral' | 'showroom' | null`
(default `null`). Any other stored value is returned as `null`.

## 4. Compatibility rules

- `salesDeskCards` off ⇒ no `lead_form` / `appointment_picker` cards, no new appointment or
  vehicle fields. Structured payloads are refused without storing anything.
- New card kinds and fields are optional; older widgets ignore unknown card kinds.
- `POST /api/chat` response shape, status code (201) and envelope are unchanged.
- State lives server-side (`Conversation.state.salesDesk`): offered form, last three pickers
  and their slots (after a booking: only the booked slot, marked `settled`). Slot ids are opaque; the provider's own slot id never reaches the client.

## 5. What is sandbox-only

- `provider_slots`, `outcome: 'confirmed'` from chat, `providerRef` and receipts are
  exercised **only** by the sandbox scheduler (`src/appointments/sandbox-scheduling.adapter.ts`,
  provider id `MOCK`). It offers a fixed synthetic grid, issues `SBX-…` references, always
  rejects one designated slot, marks receipts and cards `sandbox: true`, and its confirmation
  text says it is a demo booking, not a real appointment.
- It needs: non-production, the `sandboxScheduler` flag, and an enabled + liveReady `MOCK`
  `appointments` connection (the local demo seed creates one). In production it cannot be
  constructed, registered or resolved, and the flag is forced off.
- It is **not** a Tekion (or any vendor) integration. No vendor endpoint, URL or payload was
  added; `src/integrations/tekion` is untouched and fail-closed. A real scheduler is
  **BLOCKED** on vendor API access.
- The lead-form consent wording is new (derived from the existing `sms-continuation-v1`
  wording). It has not had legal/owner sign-off; keep `salesDeskCards` off on real rooftops
  until it has.
