# External authorization required — Jeep of Chicago canary

This document lists **only** unavoidable external dependencies.  
Repository-controlled canary infrastructure is prepared; **do not enable customer traffic** until these are satisfied and an explicit publish approval is recorded.

No passwords or secrets belong in this file.

**Last discovery pass:** 2026-07-14 resume attempt — claimed handoff/approval completion **not verified**. Railway staging `CRM_WEBHOOK_URL` still **ABSENT** (no CRM/webhook keys on backend-staging). Approval package signature fields still empty. Apollo remains **Is Enabled = False**. Employee auth regressions still pass. Do not enable Apollo; do not run website employee canary.

---

## Google Tag Manager / TeamVelocity deployment

**Status:** PATH C SELECTED — APOLLO PIXEL SAVED DISABLED

Required authorization:

- Approved GTM account access **or** TeamVelocity / dealer.com / **Apollo Tracking Pixel** deployment access
- Permission scoped to **Jeep of Chicago** (`www.jeepofchicago.com` / `jeepofchicago.com`) only
- Permission to create an **unpublished** preview workspace/version first (GTM) **or** keep Apollo **Is Enabled = False** until gates pass
- Permission to **publish** / enable only after final explicit approval

Publicly observed GTM containers (not proof of access):

`GTM-MP5XGBXQ`, `GTM-MV862RN`, `GTM-NFTX3XB`, `GTM-PZR8D88Z`, `GTM-TPV8SZS7`, `GTM-WQP4BHQ4`

Primary observed container commonly referenced: **GTM-MP5XGBXQ** — **do not modify** while Apollo is the selected path.

### Apollo / TeamVelocity (Path C) — 2026-07-14

| Field | Value |
|---|---|
| Path | **Selected** (do not also install via GTM) |
| Website | `www.jeepofchicago.com` |
| Tag name | AMQUR Internal Employee Canary |
| Placement | All Pages Body |
| Vendor | Other |
| Include on Iframes | False |
| Exclude from conversion pages | False |
| **Is Enabled** | **False** (must remain disabled) |
| Loader URL | `https://widget-staging-staging.up.railway.app/amqur-canary-loader.js` |
| Widget asset | `https://widget-staging-staging.up.railway.app/amqur-widget.1e34c88.iife.js` |
| API | `https://backend-staging-staging-b699.up.railway.app` |
| Apollo pixel ID | _Not captured in automation — record from Apollo UI if visible; no secrets_ |
| Dual-install with GTM | **Forbidden** |

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
| **C** | Apollo / TeamVelocity Tracking Pixel | **IN PROGRESS** — pixel saved, **Is Enabled = False**. Do not enable until secure employee auth (staging) + handoff + signed approval. Do not dual-install GTM. |

**Permanently unsupported:** stock Cloud SDK OAuth client + Tag Manager scopes.

### Secure employee authorization (repo)

Client-writable `amqur_emp=1` is **rejected** as sole gate. Design: backend-issued invite → HttpOnly signed cookie → eligibility API → optional strict widget-token gate for Jeep origins. See `docs/CANARY_EMPLOYEE_AUTH.md`.

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

### Discovery evidence (2026-07-14 revalidation)

Railway `amqur-platform-staging` / `backend-staging`: `CRM_WEBHOOK_URL` **ABSENT**. No handoff recipient found in approved docs. No synthetic handoff run. Apollo remains disabled.

**Resume check (same day, later):** Operator prompt asserted handoff + approval complete. Re-check of Railway staging variables found **no** `CRM_*` / `*WEBHOOK*` / `*HANDOFF*` keys on `backend-staging`. Approval table in `JEEP_OF_CHICAGO_INTERNAL_CANARY_APPROVAL.md` still blank (no approver name/role/date/evidence). Per gate rules: **do not proceed**.

Authorization request (for dealership ops — no secrets in Git/chat):  
`docs/dealership-knowledge/JEEP_OF_CHICAGO_HANDOFF_AUTHORIZATION_REQUEST.md`

Related: `docs/dealership-knowledge/jeep-of-chicago-handoff.md`  
Tracking: https://github.com/AMQUR/amqur-backend/issues/8

Until verified, customer traffic **and** Apollo enablement for Level 1 employee canary remain NO-GO for handoff-dependent flows.

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

All of the following:

1. Apollo pixel saved but still **disabled** (or GTM unpublished Preview only — never both)
2. Secure signed employee authorization passes locally + on staging; public users denied
3. Jeep origins narrowly allowlisted; forged/expired/wrong claims fail; unknown/missing Origin fail closed
4. Handoff destination / `CRM_WEBHOOK_URL` verified
5. Business approval signed (`docs/JEEP_OF_CHICAGO_INTERNAL_CANARY_APPROVAL.md`)
6. Rollback tested

Customer publication requires a **later** explicit step — not covered by this document alone.
