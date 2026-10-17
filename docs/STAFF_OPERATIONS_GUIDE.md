# Staff operations guide

What every role needs to run AMQUR safely. Everything below is in the Command Center (`/cc`).

## What the assistant does — and never does

It answers from the store's verified data, records **requests**, and hands off to people. It never confirms an appointment, approves credit, quotes a trade value, guarantees fitment, or promises a callback time. Anything that needs a person lands in a queue for you.

## Daily responsibilities by role

| Role | Where | Do this |
|---|---|---|
| Salesperson | Inbox, Service · Parts · Finance | Take over conversations that ask for a person; reply; release back to AI when done. Work OTD quote requests (send the written quote). |
| Sales manager | Same + Rooftop settings | Review hot leads and escalations; record trade appraisals and **issue trade offers** (only managers can; offers expire). |
| Service advisor | Appointments | Confirm or reschedule every REQUESTED appointment — customers are told it is a request until you confirm. |
| Service manager | Appointments, Rooftop settings | Keep service hours and holiday closures verified; amenities (shuttle/loaner) set only when true. |
| Parts advisor/manager | Service · Parts · Finance | Confirm fitment, price and availability for each parts inquiry with the VIN. |
| Finance manager | Service · Parts · Finance, Rooftop settings | Follow up on finance requests. A credit-link "clicked" is not an application and never an approval. Manage the secure credit destination (write-only). |
| General manager | Rooftop settings | Verify hours, payment/OTD policy, consent; approve credit destination; own the emergency switch. |
| Group administrator | Group comparison | All-store counts (requests vs confirmations, handoffs delivered, quotes, trades). |
| Platform operator | Ops, Integrations | Dead-letter replay, integration health, readiness scorecard. |

## Taking over a conversation

Inbox → open → **Take over** (the AI stops replying immediately) → reply → add internal notes → **Return to AI** when finished.

## Correcting what the AI knows

- Hours / amenities / policies → Rooftop settings (changes to hours require re-verification).
- Answers drawn from documents → Knowledge (draft → approve → publish; only published, customer-visible documents are used).
- A wrong answer → report it to the platform operator with the conversation link; it becomes a regression test before any fix ships.

## Emergency kill switch

Rooftop settings → **Emergency AI controls** (managers and above). Enter a reason, then:

- **Turn AI off** — the assistant stops for this store on the next message and directs customers to the dealership.
- **On — no language model** — keeps the deterministic concierge, makes zero AI-model calls.
- **Fully on** — normal operation.

Every change is audited with your name and reason. API: `POST /api/ops/locations/:id/ai-control {chat, llmDisabled, reason}`.

## Complaints and deletion requests

Complaints escalate automatically to the inbox with HIGH urgency. Customer data export/deletion: ask an admin/platform operator — handled through the audited admin API `POST /api/privacy/...` (there is no Command Center screen for it yet). Verify the requester's identity first.

## Reporting an AI error

Include: store, time, conversation link, what was wrong. Never paste SSNs, card or bank numbers anywhere.
