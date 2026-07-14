# Handoff authorization request — Jeep of Chicago internal employee canary

**Status:** AWAITING EXTERNAL AUTHORIZATION  
**Date:** 2026-07-14  
**Tracking:** https://github.com/AMQUR/amqur-backend/issues/8  

No secrets belong in this file. Do **not** paste webhook URLs, inbox addresses, or API keys into chat or Git.

---

## Why this is required

AMQUR employee canary on `www.jeepofchicago.com` may create human handoffs.  
Staging currently has **`CRM_WEBHOOK_URL` absent**. No verified dealership recipient, queue, or CRM webhook was found in approved documentation or Railway staging configuration.

Without a verified destination, Apollo pixel **AMQUR Internal Employee Canary** must remain **Is Enabled = False**.

---

## Required from Dial Auto Group / Jeep of Chicago operations

Responsible role (not a named individual invented by engineering):

- **Dial Auto Group / Jeep of Chicago BDC or Digital Operations owner** (or designated CRM administrator)

Please authorize **one** of the following for **internal employee canary test traffic only**:

| Option | Example (fill in securely) |
|---|---|
| A. Approved CRM / automation webhook | Destination stored only in Railway `CRM_WEBHOOK_URL` |
| B. Approved internal test inbox / BDC test queue | Destination stored only in ops vault + Railway |
| C. Approved TeamVelocity / Apollo lead-routing test endpoint | Destination stored only in Railway |

### Required configuration fields (ops vault — not Git)

| Field | Required |
|---|---|
| Dealership | Jeep of Chicago |
| Department | e.g. BDC / Internet Sales / Service (choose one for test) |
| Approved internal test recipient or queue | Yes |
| Notification method | webhook / email / queue |
| Business-hours behavior | Yes |
| After-hours behavior | Yes |
| Retry policy | Yes (bounded) |
| Failure destination | Yes |
| Response expectation / SLA | Yes |
| Consent requirements | Yes |
| Duplicate-prevention behavior | Yes |
| Payload ownership | Yes |
| Data-retention expectations | Yes |

### How to supply securely

1. Authorized operator sets Railway staging secret `CRM_WEBHOOK_URL` (or equivalent) via Railway UI / CLI.  
2. Do **not** paste the full URL into Slack, email threads that land in Git, or this chat.  
3. Confirm to AMQUR engineering only: **“staging CRM_WEBHOOK_URL set”** + department + test window (no secret value).  
4. AMQUR runs one synthetic handoff with fake internal data and updates issue #8.

---

## Synthetic handoff acceptance (after destination is set)

- [ ] Conversation persists  
- [ ] Escalation / handoff record persists  
- [ ] Destination receives exactly one logical delivery  
- [ ] Payload rooftop = Jeep of Chicago (`jeep-of-chicago`)  
- [ ] Retry does not duplicate leads  
- [ ] Invalid destination fails visibly  
- [ ] Delivery status auditable  
- [ ] No real customer PII used  

Close issue #8 only when the checklist passes.

---

## Status (2026-07-14 resume re-check)

| Field | Value |
|---|---|
| Railway staging `CRM_WEBHOOK_URL` | **Still ABSENT** (claimed set — not found) |
| Approval package evidence table | **Still empty** |
| Synthetic handoff | Not run |
| Apollo enable | Blocked |

Do not paste the webhook URL into chat. After setting the Railway variable, reply only with redacted confirmation fields below (no secret):

| Field | Operator confirmation (fill) |
|---|---|
| `CRM_WEBHOOK_URL` set on `backend-staging` / `staging` | yes/no |
| Department | |
| Test window (America/Chicago) | |
| Approver name + role | |
| Approval evidence ID (ticket/email/doc ref) | |
| Monitoring owner | |
| Rollback owner | |
