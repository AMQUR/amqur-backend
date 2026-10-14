# Consent and messaging

- **Ledger:** `ConsentRecord` per tenant × channel (SMS/EMAIL/CALL/WHATSAPP) × endpoint × purpose (TRANSACTIONAL/CONVERSATIONAL/MARKETING), with wording + version + source + evidence. Latest opt-out wins for the channel. A phone number on file is never consent.
- **Capture:** the widget asks explicitly ("OK for the dealership to text you…? Reply STOP anytime") only after the customer asks to continue by text; the exact wording is stored.
- **Inbound keywords:** STOP/STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT/REVOKE/OPTOUT → opt-out for conversational + marketing; START/UNSTOP/YES → re-opt-in; HELP → no change. Twilio Advanced Opt-Out `OptOutType` is honored; Twilio sends the carrier confirmation.
- **Send rules (checked on enqueue and again at send):** `sms` flag, live-ready Twilio connection, consent, frequency cap (4/24h conversational, 1/24h marketing by default), quiet hours in the dealership timezone (default 21:00–08:00, deferred not dropped). Provider opt-out errors (21610/30630) record an opt-out.
- **Delivery truth:** `OutboundMessage.status` moves to SENT only with a provider SID, DELIVERED/UNDELIVERED/FAILED only from signed status callbacks.
- **Inbound linkage:** only via an exact consented endpoint tied to a conversation; inbound texts go to the staff inbox (no autonomous SMS AI).
- **Campaigns:** created disabled; approved variables only (`{firstName} {dealerName} {appointmentDate} {appointmentTime} {vehicle}`); edits bump version and stop in-flight steps; stop on opt-out, reply, staff takeover, lead closed, appointment changed, campaign expired. Score alone never triggers a message.
