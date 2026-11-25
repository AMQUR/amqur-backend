# Implementation ledger — CRM Workforce

Status words: **Done** = built and covered by tests on synthetic data. **Blocked** = needs the approval named (see APPROVAL_REGISTER.md). **Not built** = engineering not started. Nothing here is deployed; "Deployed" and "Verified in production" are **No** for every row until release R1.

| ID | P | Component | Task | Status | Evidence | Needs | Blocker |
|---|---|---|---|---|---|---|---|
| CW-01 | 0 | Isolation | Additive module, flags, env switches, create-only migration | Done | PR #56; CI `migrations-empty-db` | R1 to deploy | — |
| CW-02 | 0 | Policy | Kill switches, modes, compliance engine, opt-out detection | Done | unit + integration tests | — | — |
| CW-03 | 0 | Queue | Priority queue, leases, dead-letter, clock-skew fix | Done | integration tests | — | — |
| CW-04 | 0 | Actions | Single-winner execution, read-back verification, reconcile before retry | Done | integration tests | — | — |
| CW-05 | 0 | Privacy | Field encryption, hashed lookup, export, erase, retention purge, audit redaction | Done | vault + privacy tests | R6 (dedicated key), R5 (backups) | Backup drill not run |
| CW-06 | 1 | Mode A | Employee-assisted workspace: enter, draft, send-in-CRM, record, continue | Done | integration + browser smoke | R1, R2, R3 | Not used by staff yet |
| CW-07 | 1 | Mode B | Export import: preview, mapping, incremental, rollback, real-data gate | Done | integration tests (synthetic files) | R4, R5 | Never run on a real Tekion export |
| CW-08 | 1 | Work items | Appointment requests, follow-ups, CRM notes, escalations, buyer alerts | Done | integration tests | — | No CRM write-back by any method |
| CW-09 | 1 | Mining | Recovery queues, age cohorts, eligibility per row | Done | integration tests | R4 for real leads | — |
| CW-10 | 1 | Facts | Hours, inventory, same-model alternatives, approved offers, department lines | Done | code + guard tests | — | Production inventory feed is not connected (existing blocker), so availability facts will be absent |
| CW-11 | 1 | Workforce | 18-role roster, group director findings, reports on request | Done | integration tests | R14 for delivery | Scheduled report delivery not built |
| CW-12 | 1 | Command Center | Today, appointments and follow-ups, lead recovery, imports, approvals, controls, compliance, connections, training, performance, audit | Done | 46 unit tests, browser smoke | R1 | — |
| CW-13 | 2 | Autonomy | Level 3 permits with every field, atomic limits | Done | integration tests | R7, R11, R12 + a verified send connector | No connector can send |
| CW-14 | 2 | Mode C | Browser connector contract | Contract only | `browser-connector.contract.ts` | R8, R9, R10 | Worker not built; must not be built before permission |
| CW-15 | 2 | Mode D | Tekion APC client | Not built | — | R9 | No spec |
| CW-16 | 2 | Comms | System SMS/email send and delivery status | Not built | — | R7, R9 | Tekion-native channel unavailable; no provider chosen |
| CW-17 | 2 | Inbound | Automatic detection of customer replies | Not built | — | R9 | No read access to Tekion conversations |
| CW-18 | 2 | Appointments | Availability, booking, reminders, show tracking | Not built | — | R9 or a scheduler integration | No scheduling source |
| CW-19 | 2 | Training | Golden evaluation dataset; manager-approved playbook revisions in the UI | Partly: reviews captured; playbooks are code | — | — | Dataset not assembled |
| CW-20 | 2 | Metrics | Pre-agent baseline; attributed sales | Not built | — | Dealership historical figures | No baseline data |
| CW-21 | 2 | Reports | Scheduled morning/midday/end-of-day/weekly delivery | Not built | reports exist on request | R14 | No approved channel |
| CW-22 | 2 | Privacy | Key rotation / re-seal job; workforce tables in the platform privacy export | Not built | — | — | — |
| CW-23 | 3 | Product | Onboarding / offboarding flow for another dealer group | Not built | multi-tenant by design | — | — |
| CW-24 | 0 | Release | Staging rehearsal and production release | Not started | RELEASE_PLAN.md | R1 | Awaiting approval |
