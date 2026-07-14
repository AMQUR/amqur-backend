# External authorization required — Jeep of Chicago canary

This document lists **only** unavoidable external dependencies.  
Repository-controlled canary infrastructure is prepared; **do not enable customer traffic** until these are satisfied and an explicit publish approval is recorded.

No passwords or secrets belong in this file.

**Last discovery pass:** 2026-07-14 (revalidated main+CI+local+staging; Path A automation still Sign-in in Playwright profile; GTM Edit for `GTM-MP5XGBXQ` unverified; handoff/`CRM_WEBHOOK` unset; stock Cloud SDK GTM OAuth unsupported)

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

### Discovery evidence (2026-07-11)

| Store | Result |
|---|---|
| Google Cloud SDK | Installed locally (`gcloud` 575.0.1) |
| Application Default Credentials | **Absent / clean** — no `application_default_credentials.json` written (no partial/broken creds) |
| ADC OAuth via stock Cloud SDK client | **BLOCKED BY GOOGLE** — consent UI: “This app is blocked — This app tried to access sensitive info in your Google Account.” Default Cloud SDK client `764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur` requesting Tag Manager scopes (`tagmanager.readonly`, `tagmanager.edit.containers`; publish scope not requested) |
| Why it failed | Google blocks the stock Cloud SDK OAuth client from Tag Manager **sensitive** scopes unless the org/user uses an **approved OAuth client**, Workspace admin allows the client, or access is granted via **tagmanager.google.com** with an authorized dealership Google account (or equivalent org-approved path) |
| Retry policy | **Do not** re-run the same default-client ADC Tag Manager scope request in a loop |
| Stuck process | Terminal `gcloud auth application-default login` (Tag Manager scopes) **terminated** after block |
| GitHub Actions GTM secrets | None listed |
| Railway staging GTM/Google vars | Absent |
| TeamVelocity / Apollo portal credential | Absent |
| GTM workspace / Preview | **Not created** |
| Public GTM publish | **Not attempted** |
| Operator Google auth (Path A) | **Succeeded** (redacted account) |
| Jeep of Chicago Google tags visible | `G-VPK5NDXW9G`, `GT-KDDGB74T` — **Google/GA4 tags, not GTM containers**; do not modify |
| GTM Accounts: `GTM-MP5XGBXQ` | **Not accessible / not listed** for current account — GTM container Edit unavailable |

### Required next external action (approved paths only)

| Path | Action | Status |
|---|---|---|
| **A** | Confirm **GTM** container `GTM-MP5XGBXQ` on Accounts with Read+Edit; create unpublished workspace `AMQUR Internal Employee Canary`; Preview only | **BLOCKED FOR AUTOMATION** — system-browser login ≠ Playwright session (Sign-in still shown in automation). Prior check: Google tags visible, **`GTM-MP5XGBXQ` not accessible**. No workspace created. No publish. |
| **B** | Org-owned OAuth client per `docs/integrations/GTM_ORG_OAUTH_CLIENT_REQUIREMENTS.md` | **BLOCKED** — awaiting org project owner |
| **C** | Submit TeamVelocity request via verified support channel | **BLOCKED** — no portal/CSM channel on this machine |

**Permanently unsupported:** stock Cloud SDK OAuth client + Tag Manager scopes.

Operator packages (ready, not activated):

- `amqur-widget/docs/deployment/jeep-of-chicago-gtm-canary.md`
- `amqur-widget/docs/deployment/jeep-of-chicago-teamvelocity-request.md`
- `amqur-widget/docs/deployment/snippets/level0-disabled.html` … `level5-full-rooftop.html`
- Resume runbook: `backend/scripts/resume-canary-after-authorization.md`
- Path B requirements: `docs/integrations/GTM_ORG_OAUTH_CLIENT_REQUIREMENTS.md`
- Approval package: `backend/docs/JEEP_OF_CHICAGO_INTERNAL_CANARY_APPROVAL.md`

Tracking: https://github.com/AMQUR/amqur-widget/issues/6

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

### Discovery evidence (2026-07-11)

Railway `amqur-platform-staging` / `backend-staging`: `CRM_WEBHOOK_URL` **not set**. No handoff-specific vars. Escalation DB persistence code path remains ready; no approved test send performed.

Related: `docs/dealership-knowledge/jeep-of-chicago-handoff.md`  
Tracking: https://github.com/AMQUR/amqur-backend/issues/8

Until verified, customer traffic **and** Level 1 employee canary against production hostname remain NO-GO for handoff-dependent flows.

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

### Discovery evidence (2026-07-11)

No `VAUTO_FEED_URL` / SFTP keys on Railway staging. Public inventory remains **disabled**. Fixture inventory blocked from public customer mode.

Onboarding: `docs/integrations/VAUTO_FEED_ONBOARDING.md`  
Tracking: https://github.com/AMQUR/amqur-backend/issues/7

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

### Discovery evidence (2026-07-11)

No Tekion client ID/secret / base URL / webhook secret on Railway staging or GitHub Actions secrets. Keep `tekionIntegration=false` and `liveReady=false`.

Onboarding: `docs/integrations/TEKION_VENDOR_ONBOARDING.md`  
Tracking: https://github.com/AMQUR/amqur-backend/issues/6

---

## Production hosts

**Status:** BLOCKED BY ACCESS

Required before Level 1 on production hostname:

- Provisioned HTTPS API origin
- CORS + tenant `allowedOrigins` for jeepofchicago.com
- Provisioned HTTPS widget CDN with version-pinned IIFE (+ optional SRI)

Staging-only reference hosts exist for **labeled** employee test pages only (see `config/canary-jeep-of-chicago.json`). Do not point unlabeled production pages at staging.

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

Approval package: `docs/JEEP_OF_CHICAGO_INTERNAL_CANARY_APPROVAL.md`  
Silence is **not** approval.

---

## Acceptance for “READY FOR INTERNAL EMPLOYEE CANARY”

All of the above that apply to Level 1, plus:

1. GTM/TV preview access verified  
2. Handoff test destination verified  
3. Production API/CDN set in loader config (fail-closed otherwise)  
4. Unpublished / employee-only tag tested  
5. Explicit stop before publish  

Customer publication requires a **later** explicit step — not covered by this document alone.
