# Dial Auto Group — Production Rollout Report

**Updated:** 2026-07-11 (CI repair + external-authorization handoff)  
**Branch:** `ops/canary-pilot-rollout`  
**Live install / customer traffic:** **not enabled**

---

## PR history

| PR | Repo | Result |
|---|---|---|
| [#4](https://github.com/AMQUR/amqur-backend/pull/4) | backend | **Merged** at head `91ff8b4` → main `ac49dd5` (early canary docs). Later harden commits were **not** in that head. |
| [#4](https://github.com/AMQUR/amqur-widget/pull/4) | widget | **Merged** at head `fe1a4e7` → main `26f7282` (early GTM index). Later loader/packages were **not** in that head. |

**CI root cause:** `pull_request` without explicit `synchronize` was insufficient in practice once PR #4 closed mid-flight; push triggers excluded `ops/**`. Later pushes could not update closed-PR checks. Workflows repaired to include `ops/**` pushes, explicit PR types, `workflow_dispatch`, concurrency, SHA receipts.

Follow-up PR (this branch): see Git section below after open.

---

## Local verification (post-CI-change)

| Check | Backend | Widget |
|---|---|---|
| npm ci / generate / validate / typecheck / tests / build | Run after commit (record in PR) | Run after commit |
| Canary safety gate script | PASSED (`resume-canary-gate-check.sh`) | n/a |
| Migration destructive scan | In CI workflow | n/a |
| Secret / IIFE scan | In CI workflow | In CI workflow |

Release rule: **tested SHA must equal current PR head SHA** or state is `CI OUTDATED — NOT MERGEABLE`.

---

## Canary package status

| Area | Status |
|---|---|
| Fail-closed loader + levels 0–5 | READY BUT DISABLED |
| GTM / TeamVelocity operator docs | READY |
| Public inventory | READY BUT DISABLED (no live vAuto) |
| Fixture inventory in public mode | READY — blocked |
| Tekion / vAuto / messaging / voice | READY BUT DISABLED |
| GTM access | BLOCKED BY ACCESS |
| TeamVelocity access | BLOCKED BY ACCESS |
| Human handoff destination | BLOCKED BY ACCESS |
| Alert routing | BLOCKED BY ACCESS |
| Customer traffic approval | BLOCKED BY BUSINESS APPROVAL |

---

## External authorization

See `docs/EXTERNAL_AUTHORIZATION_REQUIRED.md`  
Resume runbook: `scripts/resume-canary-after-authorization.md`  
Gate script: `scripts/resume-canary-gate-check.sh`

---

## Exact remaining blockers

1. GTM or TeamVelocity deploy authorization (Jeep of Chicago only)  
2. Production API + CDN hosts  
3. Verified handoff test destination  
4. Alert recipients  
5. Business approval for Level 1+  
6. Tekion partner sandbox (optional for non-CRM canary)  
7. Authorized vAuto feed (required before public inventory)

---

## Verdict

**READY FOR EXTERNAL AUTHORIZATION** — pending confirmation that follow-up PR CI is green on latest head and merged to main (complete in this automation pass).

If follow-up PR CI is not yet green / not merged, temporary state remains **NOT READY FOR CUSTOMER TRAFFIC** with repository CI incomplete.
