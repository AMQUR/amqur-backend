# Tekion connector — implementation tasks

Start these the day Tekion grants access. Asking for access is covered in `TEKION_REQUEST_PACKET.md`; this file covers building the connector. Every task names the existing contract it fills, what "done" means, and the test that proves it. Nothing here may start before the matching access is granted in writing.

## Day 0 — when sandbox credentials arrive (track 1)

| # | Task | Fills | Done when | Proof |
|---|---|---|---|---|
| T0.1 | Store credentials in Railway variables on staging only (`TEKION_APC_*`; names fixed when the spec arrives). Never put them in Git, logs or chat | — | `GET status` shows the connector as configured on staging | Variable names present; values never printed |
| T0.2 | Record the dealer ID and location ID per store in `Location.externalIds.tekion` — never in code. North and South CDJR are separate | `Location.externalIds` | All five stores mapped; a lookup refuses a store with no mapping | Unit test: unknown store → `BLOCKED` |
| T0.3 | Write an HTTP client with OAuth refresh, timeouts, retries with jitter on 429/5xx only, the circuit breaker from `CircuitBreakerService`, and a rate limiter set to Tekion's published limits | new `adapters/tekion-apc.client.ts` | A health call returns READY in sandbox | Contract test against sandbox; unit tests for 401 refresh, 429 back-off, 5xx breaker |
| T0.4 | Add a recorded-fixture mode: store sandbox responses (synthetic data only) as fixtures, so CI never calls Tekion | `test/fixtures/tekion/` | CI runs the contract suite offline | CI green without credentials |

## Day 1–3 — read scopes (APC scopes 1–5)

| # | Task | Fills | Done when | Proof |
|---|---|---|---|---|
| T1.1 | `TekionApiAdapter.listLeads`: list leads by cursor and map them to `CrmLeadRecord` with `sourceRecordId`, `asOf`, `verified: true` and `rooftopId` | `CrmAdapter.listLeads` | Leads arrive through the existing intake (`intake.service.ts`) with contact fields sealed | Contract test: mapping, pagination, store scoping (store A never returns store B) |
| T1.2 | Conversation history mapped to `CrmMessageRecord` with the source's message ids | `CrmLeadRecord.messages` | Opt-outs anywhere in the history are detected (`standingOptOuts`) | Test: a STOP three messages back suppresses the lead |
| T1.3 | `TekionReplySource.poll` / webhook receiver: verify the signature, check idempotency on the message id, store the cursor only after the page is handled | `ReplySource` (`reply-detection.contract.ts`) | A customer reply cancels unsent drafts and sets P0 within one tick | `planReply` / `orderPage` tests plus a sandbox webhook replay; bad signature → 401 and nothing stored |
| T1.4 | Contact preferences and do-not-contact per channel feed into suppression and the shared consent ledger. A missing flag never counts as consent | `CrmLeadRecord.contactPreferences` | A Tekion do-not-contact flag blocks drafting and sending | Integration test |
| T1.5 | Tasks and appointment status (read): avoid duplicate work items; show Tekion appointments as `CRM_VERIFIED` read-backs | `WorkItem` | A staff-confirmed appointment is matched to its Tekion reference | Test |
| T1.6 | Change the capability status from BLOCKED to SANDBOX VERIFIED, per operation and per store, in `capabilities()` | `Capability` | The Command Center connections tab shows the exact status | Snapshot test of the capability map |

## After approvals R7, R11 and R13 — write scopes 6–7 (Supervised mode first)

| # | Task | Fills | Done when | Proof |
|---|---|---|---|---|
| T2.1 | `executeWrite` for `message.sms.send` / `message.email.send` through Tekion with an idempotency key; `ACCEPTED` is not "sent" | `CrmAdapter.executeWrite` | A manager-approved message reaches the sandbox thread | Contract test; a duplicate key returns the same reference |
| T2.2 | `verifyWrite`: a separate read finds the message by id or body hash; only then is the action `VERIFIED` | `CrmAdapter.verifyWrite` | UNCERTAIN results are reconciled before any retry | Test: timeout → UNCERTAIN → read-back → VERIFIED with no second send |
| T2.3 | `followup.task.create` and `note.add`, each with read-back | as above | Work items can be completed in Tekion by the system | Contract test |
| T2.4 | Pass the compliance engine at execution time (already enforced) with a real CRM channel. Turn on `externalSendEnabled` for one store only after R7, R11 and R13 | `compliance.engine.ts` | One supervised send at Nissan in production, verified | Release evidence |

## Booking (scope 8)

| # | Task | Fills | Done when | Proof |
|---|---|---|---|---|
| T3.1 | `TekionSlotSource.lookup` mapped to `Slot` with provenance | `SlotSource` | `offerableSlots` returns only verified, fresh slots inside verified hours | Existing contract tests plus sandbox fixtures |
| T3.2 | `book` / `readBooking` with an idempotency key; `bookSlot` handles races | `SlotSource.book` | CONFIRMED only with Tekion's reference | Concurrency test: two bookings of one slot → one CONFIRMED, one SLOT_TAKEN |

## If track 3 (browser) is the only permission granted

Build only to `browser-connector.contract.ts`:
- a dedicated isolated browser context per store;
- handlers with expected-screen checks;
- operator-handled MFA;
- writes counted only after read-back;
- redacted traces.

No stealth plugins, no private endpoints and no MFA bypass. The task list mirrors T1–T3 with `BrowserActionHandler`s in place of HTTP calls.

## Lead delivery is not Tekion access

The AMQUR → store ADF lead delivery (production `ADF_SEND_ENABLED=true`) sends **new website leads into** Tekion. It cannot read Tekion conversations, consent, replies, owners or appointments, and it is never treated as such. Inbound lead feeds (for example LeadsBridge) can add **new lead events** as a supplementary source; they carry no Tekion history or consent.
