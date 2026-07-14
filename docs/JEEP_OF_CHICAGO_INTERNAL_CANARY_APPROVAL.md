# Jeep of Chicago — Internal Employee Canary Approval Package

**Status:** AWAITING SIGNED BUSINESS APPROVAL  
**Date prepared:** 2026-07-11  
**Last updated:** 2026-07-14  
**Release level requested:** Level 1 — INTERNAL EMPLOYEE TESTING ONLY  
**Public customer traffic:** **NOT REQUESTED. NOT AUTHORIZED.**

This package is for the authorized Dial Auto Group / Jeep of Chicago decision-maker and digital owner.  
No secrets are listed here.

**Technical readiness is not business approval.** Repository access, silence, draft docs, or developer sign-off do **not** authorize Apollo enablement.

---

## Scope of approval (must be explicit)

By signing below, the approver authorizes **only**:

| Item | Value |
|---|---|
| Dealership | Jeep of Chicago |
| Domain | `www.jeepofchicago.com` / `jeepofchicago.com` |
| Audience | Internal employees / approved testers only |
| Deployment | Apollo Tracking Pixel **AMQUR Internal Employee Canary** |
| Activation | Enable that **one** pixel after handoff verification |
| Public widget | Ordinary public sessions must remain denied |
| Public inventory | Disabled |
| Fixture inventory | Employee/labeled test only — banner **INTERNAL TEST DATA — NOT LIVE INVENTORY** |
| Tekion | Disabled |
| vAuto | Disabled |
| Appointment confirmation | Disabled |
| Automated outbound messaging | Disabled (SMS / email / WhatsApp / voice) |
| Handoff | Approved **test** destination only (see issue #8) |
| Customer traffic / limited public canary | **Not authorized by this package** |

---

## What will be tested

- Apollo pixel enablement for employee-gated loader only (or GTM Preview if Apollo path abandoned — mutually exclusive)
- Hostname restriction to Jeep of Chicago hostnames only
- Secure employee authorization: staff invite → redeem → HttpOnly signed cookie → eligibility API
- Chat bootstrap against approved staging API/CDN hosts while pixel remains employee-gated
- Lead capture + synthetic handoff to approved test destination
- English / Spanish UI
- Kill switch and rollback
- Truthfulness: no unsupported hours, staff, prices, availability, incentives, or appointment confirmation

## What remains disabled

- Public customer traffic / limited public canary
- Dual-install via GTM while Apollo is selected
- Public inventory, compare, saved vehicles, finance calculator (no live vAuto)
- Tekion production CRM writeback / scheduling / repair orders
- Automated SMS / email / WhatsApp / voice
- Live appointment confirmation
- Cross-store inventory
- Autonomous price negotiation / final finance or incentive approval
- Fixture inventory on any unlabeled public page

## No customer traffic statement

AMQUR will **not** enable customer-facing eligibility or a limited public canary under this approval.  
Only employee-gated internal access is in scope.

## Internal access method

**Selected path (2026-07-14):** Apollo / TeamVelocity Tracking Pixel **AMQUR Internal Employee Canary** — saved with **Is Enabled = False** until this package is signed **and** handoff is verified. Do not also install via GTM.

Secure redeem: staging `/canary-redeem.html` + staff `POST /api/canary/invites` — see `docs/CANARY_EMPLOYEE_AUTH.md`.

## Approved test users

_TBD by dealership digital owner — list emails or roles only; do not publish credentials._

| Tester (email or role) | Approved by | Date |
|---|---|---|
| | | |

## Fixture inventory warning

If employee-labeled test pages use fixture inventory, the page must permanently display:

**INTERNAL TEST DATA — NOT LIVE INVENTORY**

Fixture data must remain impossible in public/production customer mode.

## Human-handoff destination

_Status: NOT VERIFIED — `CRM_WEBHOOK_URL` absent on staging (2026-07-14)._  
Authorization request: `docs/dealership-knowledge/JEEP_OF_CHICAGO_HANDOFF_AUTHORIZATION_REQUEST.md`  
Tracking: https://github.com/AMQUR/amqur-backend/issues/8  

Required before Apollo enablement: approved test recipient/queue, department, business/after-hours behavior, SLA, failure path, synthetic handoff pass.

## Monitoring owner

| Field | Value |
|---|---|
| Monitoring owner | _TBD — Dial Auto Group digital / AMQUR ops_ |
| Signals | loader requests, gate denials, eligibility, widget-token, API errors, CORS, handoff delivery/failure, JS errors, CWV |
| Must not log | session cookies, invite tokens, full webhook URLs, credentials, full chat PII |

## Rollback owner

| Field | Value |
|---|---|
| Rollback owner | _TBD_ |
| Steps | 1) Disable Apollo pixel 2) `CANARY_EMPLOYEE_ENABLED=false` 3) location `featureFlags.chat=false` 4) kill QS `amqur_canary_kill=1` 5) revoke invites |

## Incident contact

_TBD — Dial Auto Group digital / AMQUR on-call_

## Test window

| Field | Value |
|---|---|
| Start (America/Chicago) | _TBD_ |
| End (America/Chicago) | _TBD_ |

## Data sources

- Verified dealership knowledge inventory (public sources only unless separately licensed)
- Staging / employee-labeled fixtures when banner present
- No live vAuto until backend issue #7 closed
- No Tekion until backend issue #6 sandbox criteria closed

## Tekion status

**DISABLED**

## vAuto status

**DISABLED** — public inventory remains off.

## Known limitations (2026-07-14)

- Secure employee canary auth deployed on staging; public sessions denied
- Apollo pixel saved disabled; pixel ID not captured in automation (record from UI if visible)
- Handoff test destination not verified (`CRM_WEBHOOK_URL` absent) — **resume re-check still ABSENT**
- Business approval unsigned — **approval evidence table still blank on resume**
- Existing third-party chat fingerprints on site — coordinate launcher placement

## Approval evidence (auditable)

Acceptable methods (one required):

- Signed copy of this document (wet or digital)
- Authenticated email approval from dealership decision-maker referencing this document title + date
- Approved internal ticket / project record with explicit Level 1 Apollo enablement language
- Authorized dealership-management confirmation recorded outside Git (link/ID only here)

| Decision | Approver name | Role | Evidence ID / link (no secrets) | Date |
|---|---|---|---|---|
| Approve Level 1 employee canary + Apollo enablement after handoff verified | | | | |
| Deny / defer | | | | |

Silence is **not** approval. Developer self-sign is **not** approval.

After approval **and** issue #8 synthetic handoff pass: enable only **AMQUR Internal Employee Canary**, run internal tests, stop before any customer-facing canary.
