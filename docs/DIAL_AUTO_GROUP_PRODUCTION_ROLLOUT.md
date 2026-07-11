# Dial Auto Group — Production Rollout Report

**Updated:** 2026-07-11  
**Canary branch:** `ops/canary-pilot-rollout`  
**Live install / customer traffic:** **not enabled**

---

## Final SHAs and CI (repository-controlled gate)

| Repo | Latest canary head SHA | PR | PR CI run | Status |
|---|---|---|---|---|
| backend | `d93e0dabe9630c5b04da23a65c91a57597b00171` | [#5](https://github.com/AMQUR/amqur-backend/pull/5) | [29168052151](https://github.com/AMQUR/amqur-backend/actions/runs/29168052151) | **PASSED** (tested SHA == head) |
| widget | `c9234f4d89891121d230e9ad2594a4834671d08b` | [#5](https://github.com/AMQUR/amqur-widget/pull/5) | [29168052735](https://github.com/AMQUR/amqur-widget/actions/runs/29168052735) | **PASSED** (tested SHA == head) |

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

**CI root cause (resolved):** workflows lacked reliable `ops/**` push triggers and head-SHA receipts; closed PR #4 could not receive later synchronize runs. Repaired: PR types `opened/reopened/synchronize/ready_for_review`, push to `main`/`audit/**`/`feature/**`/`ops/**`, `workflow_dispatch`, concurrency cancel-in-progress, SHA receipts, secret-scan path exclusions.

---

## Merge result

| Repo | Merge method | Merge commit / main tip | Main CI |
|---|---|---|---|
| backend | squash (pending/recorded at merge) | _fill after merge_ | _fill after merge_ |
| widget | squash (pending/recorded at merge) | _fill after merge_ | _fill after merge_ |

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

## Canary package status

| Area | Status |
|---|---|
| Fail-closed loader + levels 0–5 | READY BUT DISABLED |
| GTM / TeamVelocity operator docs | READY |
| Public inventory | READY BUT DISABLED (no live vAuto) |
| Fixture inventory in public mode | READY — blocked |
| Tekion / vAuto / messaging / voice | READY BUT DISABLED |
| Origin-scoped tokens / empty allowlist fail-closed | READY |
| GTM access | BLOCKED BY ACCESS |
| TeamVelocity access | BLOCKED BY ACCESS |
| Human handoff destination | BLOCKED BY ACCESS |
| Alert routing | BLOCKED BY ACCESS |
| Customer traffic approval | BLOCKED BY BUSINESS APPROVAL |

---

## External authorization

Document: `docs/EXTERNAL_AUTHORIZATION_REQUIRED.md`  
Resume runbook: `scripts/resume-canary-after-authorization.md`  
Gate script: `scripts/resume-canary-gate-check.sh`

GitHub issues (external blockers):

- [backend#6 Obtain Tekion partner sandbox access](https://github.com/AMQUR/amqur-backend/issues/6)
- [backend#7 Configure authorized vAuto feed](https://github.com/AMQUR/amqur-backend/issues/7)
- [backend#8 Verify Jeep of Chicago human-handoff routing](https://github.com/AMQUR/amqur-backend/issues/8)
- [widget#6 Obtain GTM or TeamVelocity deployment authorization](https://github.com/AMQUR/amqur-widget/issues/6)

---

## Exact remaining blockers

1. GTM or TeamVelocity deploy authorization (Jeep of Chicago only)  
2. Production API + CDN hosts (provisioned HTTPS — no localhost)  
3. Verified handoff test destination  
4. Alert recipients  
5. Business approval for Level 1+  
6. Tekion partner sandbox (optional for non-CRM canary)  
7. Authorized vAuto feed (required before public inventory)

---

## Rollback readiness

READY BUT DISABLED — Level 0 snippet / pause tags / `featureFlags.chat=false` / CDN pin revert documented in resume runbook. No live tags published.

---

## Verdict

**READY FOR EXTERNAL AUTHORIZATION** once PR #5 merges land and main CI is green (recorded below).

**NOT READY FOR CUSTOMER TRAFFIC** — no GTM publish, no Tekion/vAuto, no live dealership install.

Do not conclude READY FOR LIMITED CUSTOMER CANARY without a later explicit authorization step.
