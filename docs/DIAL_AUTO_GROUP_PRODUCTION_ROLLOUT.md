# Dial Auto Group — Production Rollout Report

**Updated:** 2026-07-11 (Paths A/B/C documented; stock Cloud SDK GTM OAuth permanently retired; Path A Sign-in pending)  
**Canary branch:** `ops/canary-pilot-rollout` (merged)  
**Live install / customer traffic:** **not enabled**  
**GTM publish:** **not attempted**  
**Stock Cloud SDK GTM OAuth:** **permanently unsupported** (Google “This app is blocked”)  
**Path A:** Google auth succeeded; Google tags visible; **GTM container `GTM-MP5XGBXQ` not accessible**  
**Path B (org OAuth client):** requirements documented — not approved  
**Path C (TeamVelocity):** template ready — not submitted (no verified channel)

---

## Final SHAs and CI (repository-controlled gate)

| Repo | Latest canary head SHA | PR | PR CI run | Status |
|---|---|---|---|---|
| backend | `5b28064cc3f00c0ada2fa4b6a524bc9fd4b1f5d3` (merged via squash) | [#5](https://github.com/AMQUR/amqur-backend/pull/5) **MERGED** | [29168187102](https://github.com/AMQUR/amqur-backend/actions/runs/29168187102) | **PASSED** (tested SHA == head) |
| widget | `c9234f4d89891121d230e9ad2594a4834671d08b` | [#5](https://github.com/AMQUR/amqur-widget/pull/5) **MERGED** | [29168052735](https://github.com/AMQUR/amqur-widget/actions/runs/29168052735) | **PASSED** (tested SHA == head) |

Push CI (same heads): backend [29168050657](https://github.com/AMQUR/amqur-backend/actions/runs/29168050657), widget [29168051004](https://github.com/AMQUR/amqur-widget/actions/runs/29168051004) — **PASSED**.

Release rule: if `tested SHA ≠ current PR head SHA` → **CI OUTDATED — NOT MERGEABLE**.

---

## PR history

| PR | Repo | Result |
|---|---|---|
| [#4](https://github.com/AMQUR/amqur-backend/pull/4) | backend | **Merged** early head `91ff8b4` → main `ac49dd5`. Later harden commits were not in that head. |
| [#4](https://github.com/AMQUR/amqur-widget/pull/4) | widget | **Merged** early head `fe1a4e7` → main `26f7282`. Later loader/packages were not in that head. |
| [#5](https://github.com/AMQUR/amqur-backend/pull/5) | backend | Follow-up: CI repair, external-auth docs, canary harden — see merge section below. |
| [#5](https://github.com/AMQUR/amqur-widget/pull/5) | widget | Follow-up: CI repair, GTM packages, canary loader tests — see merge section below. |
| [#9](https://github.com/AMQUR/amqur-backend/pull/9) | backend | Docs finalize merge report — **MERGED**. |
| [#11](https://github.com/AMQUR/amqur-backend/pull/11) | backend | External auth discovery + approval package — **MERGED** (pre–Google-block outcome). |

**CI root cause (resolved):** workflows lacked reliable `ops/**` push triggers and head-SHA receipts; closed PR #4 could not receive later synchronize runs. Repaired: PR types `opened/reopened/synchronize/ready_for_review`, push to `main`/`audit/**`/`feature/**`/`ops/**`, `workflow_dispatch`, concurrency cancel-in-progress, SHA receipts, secret-scan path exclusions.

---

## Merge result

| Repo | Merge method | Merge commit / main tip | Main CI |
|---|---|---|---|
| backend | squash merge PR #5 | `d2fb4da1bfd90dc7350a0dc462f97a66716e1178` | [29168237013](https://github.com/AMQUR/amqur-backend/actions/runs/29168237013) **PASSED** |
| widget | squash merge PR #5 | `bade56d9df128d8cdf84f9de2ee6886edc52d5f8` | [29168237681](https://github.com/AMQUR/amqur-widget/actions/runs/29168237681) **PASSED** |
| backend report | squash merge PR #9 | `59d0a6f746baad8d575a962da2a63beb05df7468` | [29168323164](https://github.com/AMQUR/amqur-backend/actions/runs/29168323164) **PASSED** |

---

## Local verification (post-CI-change)

| Check | Backend | Widget |
|---|---|---|
| prisma generate / validate | PASSED | n/a |
| typecheck / lint | PASSED (`tsc`) | PASSED (`eslint`) |
| full test suite | PASSED (30 suites / 71 tests) | PASSED (4 files / 18 tests) |
| production build | PASSED | PASSED (IIFE `AmqurWidgetBundle`) |
| canary safety gate script | PASSED (`resume-canary-gate-check.sh`) | canary package tests PASSED |
| migration destructive scan | PASSED | n/a |
| secret / IIFE scan | PASSED (CI) | PASSED (CI + local IIFE head) |

---

## Authorization status

| Area | Status |
|---|---|
| GTM access | BLOCKED BY ACCESS — Google auth OK; Google tags `G-VPK5NDXW9G`/`GT-KDDGB74T` visible (not GTM); **`GTM-MP5XGBXQ` not accessible** on GTM Accounts; stock Cloud SDK GTM OAuth unsupported |
| TeamVelocity access | BLOCKED BY ACCESS — no portal/CSM channel; Path C template not submitted |
| Human handoff | BLOCKED BY ACCESS — `CRM_WEBHOOK_URL` unset on staging; no approved test recipient |
| Tekion | BLOCKED BY VENDOR — no partner sandbox credentials (does not solely block non-CRM employee canary) |
| vAuto | BLOCKED BY VENDOR — no authorized feed; public inventory stays off |
| Production API/CDN | BLOCKED BY ACCESS — not provisioned in canary config |
| Business approval | BLOCKED BY BUSINESS APPROVAL — package prepared, unsigned |
| Org OAuth client (Path B) | BLOCKED BY ACCESS — requirements in `docs/integrations/GTM_ORG_OAUTH_CLIENT_REQUIREMENTS.md` |
| Customer traffic | **NOT AUTHORIZED** |

---

## Internal canary

| Field | Value |
|---|---|
| configuration | Level 0 active in package; Level 1 prepared, **not installed** |
| access method | GTM Preview / employee gate — **unavailable pending auth** |
| website | https://www.jeepofchicago.com (no AMQUR tag published) |
| widget version | main `bade56d` (not installed on live site) |
| backend version | main `59d0a6f` |
| enabled features | none live |
| disabled features | Tekion, vAuto, public inventory, messaging, voice, customer traffic |
| test users | TBD |
| start / end time | n/a — not started |

---

## Tests (internal employee canary)

| Suite | Status |
|---|---|
| Loading / security / truthfulness / lead / handoff / multilingual / a11y / mobile / performance / rollback | **NOT RUN on live GTM Preview** — blocked by missing GTM + handoff auth |
| Repo canary package unit tests | PASSED (widget) |
| Resume gate script | PASSED |

---

## External systems

| Provider | Authorization | Environment | Live/mock | Tested | Disabled | Remaining |
|---|---|---|---|---|---|---|
| GTM | BLOCKED BY ACCESS | n/a | n/a | Stock Cloud SDK ADC **blocked by Google** | publish + API edit | Authorized account via tagmanager.google.com, org-approved OAuth client/SA, or TeamVelocity |
| TeamVelocity | BLOCKED BY ACCESS | n/a | n/a | none | all | Portal or support case |
| Handoff / CRM webhook | BLOCKED BY ACCESS | staging | n/a | none | delivery | Approved test destination + `CRM_WEBHOOK_URL` |
| Tekion | BLOCKED BY VENDOR | disabled | mock tests only | contract/mock | production | Partner sandbox |
| vAuto | BLOCKED BY VENDOR | disabled | fixtures internal-only | anomaly guards in unit tests | public inventory | Authorized feed |

---

## Canary package status

| Area | Status |
|---|---|
| Fail-closed loader + levels 0–5 | READY BUT DISABLED |
| GTM / TeamVelocity operator docs | READY |
| Internal canary approval package | READY (unsigned) — `docs/JEEP_OF_CHICAGO_INTERNAL_CANARY_APPROVAL.md` |
| Public inventory | READY BUT DISABLED (no live vAuto) |
| Fixture inventory in public mode | READY — blocked |
| Tekion / vAuto / messaging / voice | READY BUT DISABLED |
| Origin-scoped tokens / empty allowlist fail-closed | READY |

---

## External authorization

Document: `docs/EXTERNAL_AUTHORIZATION_REQUIRED.md`  
Resume runbook: `scripts/resume-canary-after-authorization.md`  
Gate script: `scripts/resume-canary-gate-check.sh`  
Approval package: `docs/JEEP_OF_CHICAGO_INTERNAL_CANARY_APPROVAL.md`

GitHub issues (external blockers — still OPEN):

- [backend#6 Obtain Tekion partner sandbox access](https://github.com/AMQUR/amqur-backend/issues/6)
- [backend#7 Configure authorized vAuto feed](https://github.com/AMQUR/amqur-backend/issues/7)
- [backend#8 Verify Jeep of Chicago human-handoff routing](https://github.com/AMQUR/amqur-backend/issues/8)
- [widget#6 Obtain GTM or TeamVelocity deployment authorization](https://github.com/AMQUR/amqur-widget/issues/6)

---

## Exact remaining blockers

1. **GTM / TV (hard):** Complete Path A (tagmanager.google.com Sign-in + Edit on Jeep of Chicago container), **or** Path B (org OAuth client), **or** Path C (verified TeamVelocity channel). Stock Cloud SDK GTM OAuth is permanently unsupported. See [widget#6](https://github.com/AMQUR/amqur-widget/issues/6).  
2. Production API + CDN hosts (provisioned HTTPS — no localhost)  
3. Verified handoff test destination (`CRM_WEBHOOK_URL` or equivalent) — [backend#8](https://github.com/AMQUR/amqur-backend/issues/8)  
4. Alert recipients  
5. Signed business approval for Level 1 unpublished employee canary  
6. Tekion partner sandbox (optional for non-CRM canary) — [backend#6](https://github.com/AMQUR/amqur-backend/issues/6)  
7. Authorized vAuto feed (required before public inventory) — [backend#7](https://github.com/AMQUR/amqur-backend/issues/7)

---

## Git

| Item | Value |
|---|---|
| backend main SHA (pre this docs PR) | `59d0a6f746baad8d575a962da2a63beb05df7468` |
| widget main SHA | `bade56d9df128d8cdf84f9de2ee6886edc52d5f8` |
| Working tree intent | docs-only discovery + approval package |
| Live install | none |

---

## Rollback readiness

READY BUT DISABLED — Level 0 snippet / pause tags / `featureFlags.chat=false` / CDN pin revert documented in resume runbook. No live tags published.

---

## Final verdict

**READY FOR EXTERNAL AUTHORIZATION**

Repository-controlled work remains complete and green. Stock Cloud SDK GTM OAuth is permanently retired as unsupported. Path A: Google authentication succeeded, but the current account lacks GTM container access (`GTM-MP5XGBXQ` not listed). Google tags `G-VPK5NDXW9G` / `GT-KDDGB74T` are not GTM containers and were not modified. Path B org OAuth client is not approved. Path C TeamVelocity request is not submitted (no verified channel). Handoff destination and business approval remain unverified. No unpublished GTM workspace was created. No public tag was published.

Do **not** conclude **READY FOR INTERNAL EMPLOYEE CANARY** without verified GTM/TV restricted preview access **and** verified handoff **and** signed business approval.

Do **not** conclude ready for public customer traffic.
