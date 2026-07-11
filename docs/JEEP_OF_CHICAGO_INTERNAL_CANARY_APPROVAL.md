# Jeep of Chicago — Internal Employee Canary Approval Package

**Status:** AWAITING BUSINESS + DEPLOYMENT AUTHORIZATION  
**Date prepared:** 2026-07-11  
**Release level requested:** Level 1 — INTERNAL EMPLOYEE TESTING ONLY  
**Public customer traffic:** **NOT REQUESTED. NOT AUTHORIZED.**

This package is for the authorized Dial Auto Group / Jeep of Chicago decision-maker and digital owner.  
No secrets are listed here.

---

## What will be tested

- Unpublished GTM **Preview** (or equivalent TeamVelocity non-public test) of the AMQUR Level 1 employee-gated loader
- Hostname restriction to `www.jeepofchicago.com` / `jeepofchicago.com` only
- Employee gate (authenticated cookie / approved internal mechanism — not a public password)
- Chat bootstrap against provisioned HTTPS API/CDN (or labeled staging hosts only when the page visibly states internal test)
- Lead capture + service/parts request persistence to an **approved test destination**
- Human handoff delivery to an **approved test recipient** (not live BDC queues unless explicitly approved for test)
- English / Spanish UI
- Kill switch and rollback
- Truthfulness: no unsupported hours, staff, prices, availability, incentives, or appointment confirmation

## What remains disabled

- Public customer traffic / published GTM container version for AMQUR
- Public inventory, compare, saved vehicles, finance calculator (no live vAuto)
- Tekion production CRM writeback / scheduling / repair orders
- Automated SMS / email / WhatsApp / voice
- Live appointment confirmation
- Cross-store inventory
- Autonomous price negotiation / final finance or incentive approval
- Fixture inventory on any unlabeled public page

## No customer traffic statement

AMQUR will **not** be published to the live Jeep of Chicago GTM container version for customers in this approval.  
Only GTM Preview / unpublished workspace / employee-gated internal access is in scope.

## Internal access method

Preferred: GTM workspace `AMQUR Internal Employee Canary` + **Preview mode** + Level 1 employee gate.  
Fallback: TeamVelocity unpublished / internal script entry limited to Jeep of Chicago hostnames.

## Approved test users

_TBD by dealership digital owner — list emails or roles only; do not publish credentials._

## Fixture inventory warning

If employee-labeled test pages use fixture inventory, the page must permanently display:

**INTERNAL TEST DATA — NOT LIVE INVENTORY**

Fixture data must remain impossible in public/production customer mode.

## Human-handoff destination

_Status: NOT VERIFIED — see GitHub issue AMQUR/amqur-backend#8._  
Required before Level 1 live preview against production hostname: approved test recipient, department, business/after-hours behavior, SLA, escalation failure path.

## Monitoring

Bootstrap success/fail, blocked public init, token/CORS failures, truth-engine blocks, test lead/handoff delivery, JS errors, CWV impact.  
Do not log full chat content or credentials unless separately approved.

## Rollback

1. End GTM Preview / disable workspace tags  
2. Kill switch `?amqur_canary_kill=1`  
3. Server `featureFlags.chat=false` for location  
4. Pause TeamVelocity script entry if used  
5. Revert CDN pin if applicable  

## Test window

_TBD — start/end America/Chicago_

## Responsible owner

| Role | Name | Contact |
|---|---|---|
| Business approver | _TBD_ | |
| Rollback owner | _TBD_ | |
| Monitoring owner | _TBD_ | |
| AMQUR engineering | _TBD_ | |

## Data sources

- Verified dealership knowledge inventory (public sources only unless separately licensed)
- Staging / employee-labeled fixtures when banner present
- No live vAuto until issue #7 closed
- No Tekion until issue #6 sandbox criteria closed

## Tekion status

**DISABLED** — partner sandbox not authorized on this machine / Railway staging.

## vAuto status

**DISABLED** — no authorized feed; public inventory remains off.

## Known limitations

- Production API/CDN hosts not yet provisioned in canary config (fail-closed until set)
- GTM container access not yet verified for this operator account
- TeamVelocity portal credential not present
- Handoff test destination not verified (`CRM_WEBHOOK_URL` unset on staging)
- Existing third-party chat fingerprints on site — coordinate launcher placement

## Approval

Silence is **not** approval.

| Decision | Signature / recorded approval | Date |
|---|---|---|
| Approve Level 1 unpublished employee canary only | | |
| Deny / defer | | |

After approval: follow `scripts/resume-canary-after-authorization.md` and **stop before publish**.
