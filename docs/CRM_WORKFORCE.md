# AMQUR CRM Workforce

An additive division of the AMQUR backend that works CRM leads for a dealership: it reads leads through a CRM adapter, decides which need attention, drafts short replies through the existing model gateway, and — only where every gate allows — sends them. It does not replace or touch the Dial Concierge.

**Status as of 2026-11-25:** implemented and tested locally on branch `feat/crm-workforce`. Not deployed. No CRM is connected. No customer has been contacted. Customer sending cannot be turned on by this code alone (see [What must be true before a message is sent](#what-must-be-true-before-a-message-is-sent)).

## What is on and what is off

| Capability | Status | Why |
|---|---|---|
| Policy core, queue, supervisor, action pipeline, Command Center screens | DEMO | Proven by tests against the synthetic fixture CRM only |
| Dealership CRM export import (CSV, read-only) | NOT TESTED | Implemented; never run on a real export |
| Employee-assisted workflow (staff sends in the CRM, confirms here) | NOT TESTED | Implemented; never used by staff |
| Tekion APC (authorized API) | BLOCKED | No spec, scopes, sandbox or credentials issued; the adapter has no HTTP client |
| Tekion CRM browser operations | BLOCKED | No written automation permission on record; the adapter has no browser driver and no selectors |
| Customer SMS / email sending | BLOCKED | No approved channel provider, no counsel-approved policy, no authorization |
| Appointment booking | BLOCKED | No scheduling provider; agents may only pass a requested time to staff |

## How it is kept apart from the concierge

- New code lives in `src/crm-workforce/`. The only edits to existing files are: one import in `app.module.ts`, one default-off flag in `feature-flags.service.ts`, one env-gated interval in `worker.ts`, one nav entry in the Command Center.
- Twelve new tables, all prefixed `CrmWf`. The migration (`20261125090000_crm_workforce`) creates tables, enums and indexes only; it alters no existing table.
- It registers no handler in the existing outbox, adds no public endpoint, and changes no widget or chat route.
- Reused, not duplicated: model gateway (`LlmRouterService`), consent ledger (`ConsentService`), store hours, inventory feed, feature flags, turn locks, circuit breaker, staff auth and roles, `AuditLog`, Command Center.

## Switches

All default off. Read at decision time, so a change takes effect on the next check.

| Switch | Where | Effect |
|---|---|---|
| `crmWorkforce` | Tenant / Location feature flag | Lets a rooftop be configured and worked |
| `CRM_WORKFORCE_ENABLED=true` | Worker env | Starts the engine loop in the worker process |
| `CRM_WORKFORCE_EXTERNAL_SEND_ENABLED=true` | API + worker env | Deployment-level permission to send; nothing sends without it |
| `CRM_WORKFORCE_EMERGENCY_STOP=true` | Env | Halts everything, no database needed |
| `CRM_WORKFORCE_BATCH`, `CRM_WORKFORCE_POLL_MS`, `CRM_WORKFORCE_DRAFT_MODEL` | Worker env | Tasks per tick (default 10), tick interval (20 s), optional model override |

Kill switches and pauses are rows in `CrmWfControl` at GLOBAL, TENANT, LOCATION, DEPARTMENT, WORKFLOW or SALESPERSON scope. Any staff member can stop; only a manager can resume; only an admin can raise a mode or enable sending; only the platform operator can set the GLOBAL row or the communication policy. A row that only carries a kill switch states no mode, so releasing it restores what was configured before.

## Operating modes (per rooftop, starts at Observe)

| Mode | What happens |
|---|---|
| Observe | Leads are read and prioritised. No model call, no draft, no write. |
| Assist | Drafts are written for employees, who send them in the CRM themselves and confirm. |
| Supervised | A manager approves each message; the system sends it. |
| Controlled autonomous | Pre-authorised routine workflows send without per-message approval. Needs a complete written authorization on the workflow (document reference, signer, audience, channels, daily limit, window). |

## What must be true before a message is sent

Checked in code (`policy/compliance.engine.ts`), outside the model, when a draft is written and again at the moment of sending:

1. No kill switch or pause on the path; process switch on; deployment send switch on; rooftop send switch on; mode is Supervised or Controlled autonomous.
2. No suppression for the customer (channel or all-channel); CRM does not mark do-not-contact.
3. A consent record for that channel and purpose in the consent ledger. A phone number, a CRM flag or an old record is not consent. Marketing needs a marketing grant no older than the policy limit.
4. No human owner active on the conversation; lead not paused; no other open message for the lead.
5. For outbound: inside the contact window in the customer's time zone, under daily and weekly caps, under the unanswered-attempt limit, lead source not restricted.
6. An approved virtual identity for the department; a CRM connection whose send capability is verified; a communication policy with counsel approval on record.
7. A human approval on the action, unless the workflow is authorised for controlled autonomy.

An opt-out (STOP, unsubscribe, "stop texting me", wrong number) anywhere in the conversation history suppresses the lead, cancels its open tasks and unsent messages, and is mirrored into the shared consent ledger. Staff cannot lift a customer's own opt-out.

## Message statuses

`DRAFT`, `PENDING_APPROVAL`, `APPROVED`, `EXECUTING`, `SENT_UNVERIFIED`, `UNCERTAIN`, `VERIFIED`, `STAFF_CONFIRMED`, `BLOCKED`, `FAILED`, `REJECTED`, `CANCELLED` are different things. Only `VERIFIED` (the adapter re-read the CRM and found the message) is shown as sent. `STAFF_CONFIRMED` is an employee's statement. An unknown result is `UNCERTAIN`; it is reconciled against the CRM before any retry, and a retry reuses the same idempotency key.

## Agents

Sales BDC, Service BDC, Parts BDC, Lead Recovery, Conversation Manager and Appointment Manager are playbooks (`agents/playbooks.ts`, versioned in code) run by one supervisor (`supervisor.service.ts`). The supervisor decides whether a task may proceed; agents only write text. Every draft passes a deterministic guard (`agents/output-guard.ts`): length, one question, no emoji or filler, no urgency, no impersonation, virtual disclosure on first contact, and no price, payment, approval, availability, booking, diagnosis or fitment claim without a verified fact of that kind. A draft that fails twice goes to a person. Complaints, negotiation, financing, legal, safety, sensitive data and requests for a person always go to a person.

Proposed identities (changeable by an admin; must be disclosed as virtual; may not match an employee's name): Chevy — Alex; Nissan — Sarah; INFINITI — Victoria; CDJR South — James; Jeep North — Ryan.

## Priorities

P0 customer waiting on a reply · P1 new lead, no response · P2 appointment change · P3 ready to buy · P4 missed appointment / visited, not sold · P5 engaged, needs follow-up · P6 overdue follow-up · P7 older-lead reactivation. Inputs are CRM operational facts only; each decision stores its rule and the facts it read.

## API and screens

Staff API: `/api/ops/crm-workforce/*` (staff JWT; tenant from the token; staff and managers bound to their rooftop). Command Center: `/cc/#/crm-workforce` — overview, queues, draft approvals, AI workforce, modes and kill switches, compliance, CRM connections and workers, agent training, performance and costs, audit ledger. Numbers are counts of recorded events; synthetic records are labelled DEMO; a missing number is shown as missing.

## Run it locally

```bash
set -a && . ./test-infra/.env.test && set +a
npx prisma migrate deploy
DEMO_ADMIN_EMAIL=you@example.com DEMO_ADMIN_PASSWORD='…' npm run seed:crm-workforce-demo
npm run build:all && node dist/main.js      # then open /cc/#/crm-workforce
```

Tests: `npx jest src/crm-workforce` (unit), `npx jest --config ./test/jest-e2e.json --runInBand --forceExit --testPathPatterns='suites/crm-workforce'` (integration; needs the test Postgres and Redis), `npx vitest run` and `npx playwright test e2e/crm-workforce.spec.ts` in `command-center/`.

## Deploy and roll back

Deploy is the normal backend release: the API container runs `prisma migrate deploy` (adds the `CrmWf` tables), then starts. With no env switch set, the engine does not start and the flag is off for every tenant, so behaviour is unchanged.

Roll back, least to most invasive:

1. Stop one rooftop, department or workflow from the Command Center, or set the GLOBAL control row `halted`.
2. `CRM_WORKFORCE_EMERGENCY_STOP=true`, or unset `CRM_WORKFORCE_ENABLED` and restart the worker.
3. Set `crmWorkforce` to false on the tenant.
4. Redeploy the previous commit (local tag `crm-workforce-baseline-20261125` = `2d06fe2`). The new tables are left in place; nothing else reads them. The schema is never rolled back.

## Needed from the owner before anything goes live

| Item | Unblocks |
|---|---|
| Tekion subscription agreement review and written automation permission, or APC API scopes | Any Tekion connector |
| A recorded authorization to import CRM exports, per rooftop | CSV import of real leads |
| Channel provider and sender registration (SMS / email) with a verified send-and-read-back capability | Any system send |
| Counsel-approved communication policy (limits, window, wording) | Any system send |
| Consent records for the contacts to be messaged | Any message to that contact |
| Written authorization per workflow (audience, channel, limits, window) | Controlled autonomy |
| Decision on virtual identities and the pilot rooftop | Pilot |
