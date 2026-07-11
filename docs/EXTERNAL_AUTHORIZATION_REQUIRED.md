# External authorization required — Jeep of Chicago canary

This document lists **only** unavoidable external dependencies.  
Repository-controlled canary infrastructure is prepared; **do not enable customer traffic** until these are satisfied and an explicit publish approval is recorded.

No passwords or secrets belong in this file.

---

## Google Tag Manager / TeamVelocity deployment

**Status:** BLOCKED BY ACCESS

Required authorization:

- Approved GTM account access **or** TeamVelocity / dealer.com deployment access
- Permission scoped to **Jeep of Chicago** (`www.jeepofchicago.com` / `jeepofchicago.com`) only
- Permission to create an **unpublished** preview workspace/version first
- Permission to **publish** only after final explicit approval

Publicly observed GTM containers (not proof of access):

`GTM-MP5XGBXQ`, `GTM-MV862RN`, `GTM-NFTX3XB`, `GTM-PZR8D88Z`, `GTM-TPV8SZS7`, `GTM-WQP4BHQ4`

Primary observed container commonly referenced: **GTM-MP5XGBXQ**

Operator packages (ready, not activated):

- `amqur-widget/docs/deployment/jeep-of-chicago-gtm-canary.md`
- `amqur-widget/docs/deployment/jeep-of-chicago-teamvelocity-request.md`
- `amqur-widget/docs/deployment/snippets/level0-disabled.html` … `level5-full-rooftop.html`
- Resume runbook: `backend/scripts/resume-canary-after-authorization.md`

---

## Human handoff

**Status:** BLOCKED BY ACCESS / BLOCKED BY BUSINESS APPROVAL

Required verified details (do not invent):

- Recipient identity
- Department
- Approved **test** destination (inbox/API)
- Business-hours routing
- After-hours routing
- SLA
- Escalation channel

Related: `docs/dealership-knowledge/jeep-of-chicago-handoff.md`

Until verified, customer traffic remains NO-GO even if GTM access appears.

---

## vAuto

**Status:** BLOCKED BY VENDOR

Required:

- Authorized feed transport (HTTPS / SFTP / FTPS as contracted)
- Credentials (store in Railway / Keychain — never Git)
- Feed format (XML / CSV / JSON)
- Location mapping for Jeep of Chicago
- Expected schedule
- Freshness threshold
- Approved customer-visible fields

Until connected: **public inventory remains disabled**. Fixture inventory must never appear on customer pages.

Onboarding: `docs/integrations/VAUTO_FEED_ONBOARDING.md`

---

## Tekion

**Status:** BLOCKED BY VENDOR

Required:

- Partner approval
- Official API documentation
- Sandbox credentials
- Approved scopes
- Webhook signing details
- Tenant/location mappings

Keep `tekionIntegration=false` and `liveReady=false` until sandbox checklist completes.

Onboarding: `docs/integrations/TEKION_VENDOR_ONBOARDING.md`

---

## Production hosts

**Status:** BLOCKED BY ACCESS

Required before Level 1 on production hostname:

- Provisioned HTTPS API origin
- CORS + tenant `allowedOrigins` for jeepofchicago.com
- Provisioned HTTPS widget CDN with version-pinned IIFE (+ optional SRI)

---

## Tracking issues

- Tekion: https://github.com/AMQUR/amqur-backend/issues/6
- vAuto: https://github.com/AMQUR/amqur-backend/issues/7
- Human handoff: https://github.com/AMQUR/amqur-backend/issues/8
- GTM / TeamVelocity: https://github.com/AMQUR/amqur-widget/issues/6

---

## Customer traffic approval

**Status:** BLOCKED BY BUSINESS APPROVAL

Required:

- Authorized person approving the Jeep of Chicago canary
- Approved release level (0–5; start at 1 employee-only)
- Approved date/time window
- Rollback owner
- Monitoring owner / verified alert recipients

---

## Acceptance for “READY FOR INTERNAL EMPLOYEE CANARY”

All of the above that apply to Level 1, plus:

1. GTM/TV preview access verified  
2. Handoff test destination verified  
3. Production API/CDN set in loader config (fail-closed otherwise)  
4. Unpublished / employee-only tag tested  
5. Explicit stop before publish  

Customer publication requires a **later** explicit step — not covered by this document alone.
