# Dial Nissan pilot — employee-assisted operations

**Proposed, not started.** Dial Nissan is the proposed first rooftop. No Nissan customer record has been imported or contacted, and the Tekion dashboard has not been read: there are no current lead counts in this document on purpose.

## What employees do each day

In the Command Center, **CRM Workforce → Today** lists five queues in this order:

1. Unanswered customer messages
2. New leads, not contacted
3. Appointments to confirm
4. No follow-up scheduled
5. Visited, not sold

Until an export is authorized (R4), the queues are empty and employees use **Enter a customer from the CRM**: first name, salesperson, vehicle, and what the customer wrote — no phone or email. Then:

- **Write a reply** → a short draft in the employee's own voice, with anything the system could not confirm listed above it.
- The employee edits, copies, sends it **from Tekion**, and clicks **I sent this in the CRM**.
- When the customer answers, the employee pastes the reply and asks for the next draft; the whole conversation is used.
- **Request appointment / follow-up / note** creates an item for the owner. An appointment stays a request until an employee books it in Tekion and enters the Tekion reference.
- Complaints, price negotiation, financing, legal, safety and "talk to a person" are not drafted: they become an item for a person.
- "Stop" in any customer message: nothing is drafted, the contact is suppressed.

## Setup (after release approval R1 and pilot approval R2)

```bash
npx ts-node --transpile-only scripts/crm-workforce-pilot-setup.ts --tenant dial-nissan-of-chicago          # shows the plan, writes nothing
CRM_WORKFORCE_PILOT_APPROVAL_REF=<approval id> npx ts-node --transpile-only scripts/crm-workforce-pilot-setup.ts --tenant dial-nissan-of-chicago --apply
```

Result: flag on for Nissan only, Assist mode, customer sending off, employee-assisted connection on, identity "Sarah — Virtual BDC Manager" on file. The engine stays off; drafting in the workspace does not need it.

## Limits during the pilot

- Model calls: `CRM_WORKFORCE_DAILY_DRAFT_LIMIT` (default 500 per rooftop per day). Each draft is one call.
- No system sends. No Tekion connection. No real import until R4 and R5.

## What to measure (from recorded events only)

Drafts written, drafts sent by employees, drafts discarded or edited, items opened and closed, time from customer message entered to "sent", handoffs, opt-outs, model cost per draft. Appointments and sales are the dealership's own Tekion figures; the workspace records only what employees state.

## Exit criteria to request a live workflow

Two weeks of daily use by named employees; edit rate and discard reasons reviewed by a manager; zero messages the dealership considers wrong on fact; R4, R5, R7 and R9 closed. Then one narrow permit (R12) for one workflow.
