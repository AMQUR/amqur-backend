# Dial Auto Group — Production Rollout Report

**Updated:** 2026-07-14 (final production-completion revalidation)  
**Live install / customer traffic:** **not enabled**  
**GTM publish:** **not attempted**  
**Publication status:** **UNPUBLISHED**

---

## Executive summary

| Item | Status |
|---|---|
| Initial condition | Repository-controlled hardening + canary packages complete; prior verdict READY FOR EXTERNAL AUTHORIZATION |
| Completed this pass | Revalidated main/CI; clean local verification; staging live health + origin fail-closed probes; docs sync |
| Current production status | **No public Jeep of Chicago install.** Staging healthy. GTM Edit / handoff / business approval still external blockers |

---

## Git

| Repo | Origin | Branch | Main SHA | Main CI | Clean |
|---|---|---|---|---|---|
| backend | AMQUR/amqur-backend | main | `9bbede5d7b5d14b02e802d9d89136f98448961ce` | [29170747883](https://github.com/AMQUR/amqur-backend/actions/runs/29170747883) **PASSED** | yes (matches origin/main) |
| widget | AMQUR/amqur-widget | main | `1e34c888976e8cbd5a3b998f3aa96c1c8807d7aa` | [29170446644](https://github.com/AMQUR/amqur-widget/actions/runs/29170446644) **PASSED** | yes (untracked: `.playwright-cli/`, `staging/public/` local only — not committed) |

Release rule: tested SHA must equal PR head or state is **CI OUTDATED — NOT MERGEABLE**.

---

## Local verification (2026-07-14)

| Check | Backend | Widget |
|---|---|---|
| npm ci | PASSED | PASSED |
| prisma generate / validate | PASSED | n/a |
| typecheck / lint | PASSED (`tsc`) | PASSED (`eslint`) |
| full tests | PASSED (30 suites / 71 tests) | PASSED (4 files / 18 tests) |
| production build | PASSED | PASSED (IIFE `AmqurWidgetBundle`, ~614 kB) |
| migration destructive scan | PASSED | n/a |
| resume-canary-gate-check.sh | PASSED | canary package tests PASSED |

---

## Infrastructure (staging)

| Item | Value |
|---|---|
| Railway workspace | saadimranhere’s Projects (AMQUR staging project) |
| Project | `amqur-platform-staging` (`e4d54510-…`) |
| Environment | `staging` only |
| backend-staging | Online — https://backend-staging-staging-b699.up.railway.app |
| widget-staging | Online — https://widget-staging-staging.up.railway.app |
| Postgres / Redis | Online (dedicated staging volumes) |
| Production Railway | **Not provisioned / not activated in this pass** |
| GTM workspace | **Not created** |
| Live GTM container edit | **Not verified** for `GTM-MP5XGBXQ` |

### Staging probes (2026-07-14)

| Probe | Result |
|---|---|
| `GET /api/health` | PASSED — 200, database up |
| `GET /api/health/live` | PASSED — 200 |
| `GET /api/health/ready` | SKIPPED WITH JUSTIFICATION — route 404; readiness embedded in `/api/health` |
| Widget IIFE HTTPS + `application/javascript` | PASSED |
| Staging host page banner | PASSED — “STAGING — NOT FOR CUSTOMERS”; fixture inventory labeled |
| Widget-token missing Origin | PASSED — 403 fail-closed |
| Widget-token `Origin: https://evil.example` | PASSED — 403 |
| Widget-token staging widget Origin | PASSED — 201 |
| Widget-token production jeepofchicago Origin on staging tenant | PASSED — 403 (correct isolation) |
| CRM_WEBHOOK_URL | UNAVAILABLE — not set |
| Tekion / vAuto secrets | UNAVAILABLE — not set |

---

## Authorization status

| Area | Status |
|---|---|
| GTM access | BLOCKED BY ACCESS — Playwright automation still on Sign-in (isolated profile). Google tags ≠ GTM. `GTM-MP5XGBXQ` Edit not verified. Stock Cloud SDK GTM OAuth permanently unsupported. |
| TeamVelocity / Apollo | Pixel **saved**, **Is Enabled = False** — do not enable until gates complete |
| Org OAuth client (Path B) | BLOCKED BY ACCESS — requirements documented |
| Human handoff | BLOCKED BY ACCESS — `CRM_WEBHOOK_URL` **ABSENT** on staging; authorization request prepared |
| Business approval | BLOCKED BY BUSINESS APPROVAL — package ready for signature; unsigned |
| Tekion | BLOCKED BY VENDOR — disabled |
| vAuto | BLOCKED BY VENDOR — disabled; public inventory off |
| Production API/CDN for jeepofchicago.com | Staging hosts used in Apollo payload only; production canary config hosts still BLOCKED |
| Secure employee canary auth | **LIVE ON STAGING** — invite audited; public denied; Jeep strict origins |
| Customer traffic | **NOT AUTHORIZED** |

### 2026-07-14 gate revalidation

| Check | Result |
|---|---|
| Backend/widget `HEAD == origin/main` | PASSED at revalidation |
| Main CI | PASSED |
| Staging API health | 200 |
| Canary loader `application/javascript` | PASSED |
| Jeep widget-token without session | 403 |
| `amqur_emp=1` eligibility | denied |
| `CRM_WEBHOOK_URL` | ABSENT |
| Business approval | UNSIGNED |
| Apollo Is Enabled | False (must remain) |
| Synthetic handoff | NOT RUN — blocked |
| Website employee canary | NOT STARTED — blocked |
| Limited public canary | NOT AUTHORIZED |

### 2026-07-14 production completion revalidation

| Check | Result |
|---|---|
| Backend `origin/main` | `fedd115` (pre-handoff-queue PR; advances after merge) |
| Widget `origin/main` | `18ebd53` |
| Main CI | Green |
| Staging health / loader / IIFE | 200 |
| Jeep widget-token without session | 403 |
| `CRM_WEBHOOK_URL` (staging) | **ABSENT** |
| Official Railway production project | **MISSING** — only `amqur-platform-staging` is labeled for AMQUR |
| Unlabeled Railway `divine-integrity` | EXISTS with personal fork `saadimranhere/amqur-backend` — **DO NOT USE** as AMQUR production |
| Unlabeled Railway `distinguished-laughter` | Empty / unused — **DO NOT USE** |
| Business approval Stages 1–3 | **UNSIGNED** |
| Apollo Is Enabled | False |
| Staff handoff queue API | claim/ack/resolve/notes + dedupe (this PR) — still needs named owner before it counts as production handoff |

**Verdict at this pass:** cannot enable Apollo or start employee/public canary until handoff destination **or** owned first-party queue + Stage 1 approval.

---

## Internal canary

| Field | Value |
|---|---|
| Status | PREPARED — Apollo pixel saved **disabled**; not customer-live |
| Release level | 0 |
| Deployment path | Apollo / TeamVelocity (Path C) — do not dual-install GTM |
| Apollo tag | AMQUR Internal Employee Canary · Is Enabled = **False** |
| Apollo pixel ID | _record from UI if visible_ |
| GTM workspace | none (do not create while on Apollo path) |
| Preview / publish | **none** — Apollo disabled |
| Employee gate | Signed invite → HttpOnly cookie → eligibility (see `CANARY_EMPLOYEE_AUTH.md`) |
| Disabled | Tekion, vAuto, public inventory, messaging, voice, live appointment confirmation, customer traffic |

---

## Features

| Class | Items |
|---|---|
| Enabled (repo/staging only) | Staging chat + labeled fixture inventory on staging host; origin-scoped tokens; canary loader package |
| Disabled (production canary package) | Public inventory, Tekion, vAuto, messaging, voice, live appointment confirmation |
| Vendor blocked | Tekion, vAuto |
| Business / access blocked | GTM Edit, TeamVelocity, handoff destination, Level 1+ approval |

---

## Tests

| Suite | Status |
|---|---|
| Local backend/widget | PASSED |
| Main CI | PASSED |
| Staging health / origin security | PASSED |
| Employee canary E2E on GTM Preview | NOT RUN — blocked by GTM Edit + handoff |
| Limited customer canary | NOT RUN — not authorized |
| Rollback on live GTM | NOT RUN — nothing published |

---

## External integrations

| Provider | Auth | Env | Live/mock | Enabled |
|---|---|---|---|---|
| GTM | BLOCKED BY ACCESS | n/a | n/a | no |
| TeamVelocity | BLOCKED BY ACCESS | n/a | n/a | no |
| Handoff webhook | BLOCKED BY ACCESS | staging | n/a | no |
| Tekion | BLOCKED BY VENDOR | disabled | mock tests | no |
| vAuto | BLOCKED BY VENDOR | disabled | fixture staging-only | no |

---

## Exact remaining blockers

1. **Handoff:** Set Railway staging (then production) `CRM_WEBHOOK_URL` securely **or** accept ownership of first-party staff escalation queue — [backend#8](https://github.com/AMQUR/amqur-backend/issues/8)
2. **Stage 1 approval** — `docs/JEEP_OF_CHICAGO_PRODUCTION_RELEASE_APPROVAL.md` + GitHub approval issue
3. **Official AMQUR production Railway project** — create/label `amqur-platform-production` under AMQUR org ownership; do **not** use unlabeled `divine-integrity` / personal forks
4. Synthetic handoff pass → enable Apollo employee canary only
5. Stages 2–3 before limited/full public traffic
6. Tekion / vAuto remain vendor-blocked ([#6](https://github.com/AMQUR/amqur-backend/issues/6), [#7](https://github.com/AMQUR/amqur-backend/issues/7))

Do not enable customer traffic. Do not use staging URLs as final public production hosts.

---

## Remaining risks

| Severity | Risk |
|---|---|
| Critical | Publishing without GTM Edit verification or handoff |
| High | Fixture inventory leaking to public mode (currently blocked by config + tests) |
| Medium | Staging inventory flag true only on labeled staging host — must never map to production origins |
| Low | `/api/health/ready` alias missing (readiness covered by `/api/health`) |

---

## Final verdict

**READY FOR EXTERNAL AUTHORIZATION**

Repository-controlled work and staging remain green. No repository-controlled release defect found in this revalidation. Required provider/business permissions (GTM container Edit for `GTM-MP5XGBXQ`, handoff destination, business approval) remain missing. No unpublished GTM workspace was created in a controllable session. No public customer traffic.

Do **not** conclude READY FOR INTERNAL EMPLOYEE CANARY, READY FOR LIMITED CUSTOMER CANARY, PRODUCTION READY, or FULL PRODUCTION READY without those gates.

---

## Pause — Path A action required

A headed Playwright window and/or system browser is on Google Tag Manager Sign-in.

**Please complete official Google login / SSO / MFA** in that window with the account that has **GTM** access to Jeep of Chicago container `GTM-MP5XGBXQ` (not only Google tags `G-…` / `GT-…`).

Do not paste passwords or tokens into chat. After login succeeds, say so and automation will resume: verify permissions, create unpublished workspace `AMQUR Internal Employee Canary`, Preview only — **no publish**.
