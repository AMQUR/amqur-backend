# Jeep of Chicago — Production Release Approval

**Status:** AWAITING AUTHORIZED BUSINESS APPROVAL  
**Prepared:** 2026-07-14  
**Dealership:** Jeep of Chicago  
**Domain:** `www.jeepofchicago.com` / `jeepofchicago.com`  

Silence is **not** approval. Developer self-sign is **not** approval.  
No secrets belong in this file.

Tracking issue: https://github.com/AMQUR/amqur-backend/issues/20

---

## Stage 1 — Internal employee canary

| Field | Value |
|---|---|
| Scope | Apollo pixel **AMQUR Internal Employee Canary** only; ordinary visitors denied |
| Approved employee testers | _TBD_ |
| Test window (America/Chicago) | _TBD_ |
| Approved handoff destination | External webhook **or** first-party staff queue with named owner |
| Monitoring owner | _TBD_ |
| Rollback owner | _TBD_ |
| Fixture inventory | Employee/labeled only; banner **INTERNAL TEST DATA — NOT LIVE INVENTORY** |
| Disabled | Public inventory, Tekion, vAuto, live pricing/incentives, appointment confirmation, automated outbound messaging, voice, customer traffic |
| Incident contact | _TBD_ |

| Decision | Approver name | Role | Evidence ID | Date |
|---|---|---|---|---|
| Approve Stage 1 | | | | |
| Deny / defer | | | | |

---

## Stage 2 — Limited public canary

Do not start until Stage 1 passed and recorded.

| Field | Value |
|---|---|
| Starting percentage | 1% |
| Eligible traffic | Jeep of Chicago hostnames only |
| Enabled features | Education, EN/ES, lead/service/parts capture, verified handoff, payment estimates with assumptions |
| Disabled features | Inventory, pricing, incentives, Tekion, vAuto, appointment confirmation, outbound automation, voice, fixtures |
| Monitoring / rollback thresholds | _TBD by ops_ |
| Test duration | _TBD_ |

| Decision | Approver name | Role | Evidence ID | Date |
|---|---|---|---|---|
| Approve Stage 2 | | | | |
| Deny / defer | | | | |

---

## Stage 3 — Full pilot-rooftop production

Do not start until Stage 2 passed and recorded.

| Field | Value |
|---|---|
| Scope | 100% Jeep of Chicago only (no other Dial Auto Group rooftops) |
| Final enabled features | Same as Stage 2 public-safe set |
| Vendor limitations | Tekion disabled; vAuto disabled; public inventory disabled |
| Handoff / monitoring / rollback owners | _TBD_ |

| Decision | Approver name | Role | Evidence ID | Date |
|---|---|---|---|---|
| Approve Stage 3 | | | | |
| Deny / defer | | | | |

---

## Acceptable evidence

- Authenticated GitHub issue comment by authorized business owner
- Signed document / authenticated dealership email
- Approved internal ticket referencing this document title + stage number

Highest honest production state with vendors unavailable: **PRODUCTION READY WITH VENDOR FEATURES DISABLED** (only after Stages 1–3 complete with evidence).
