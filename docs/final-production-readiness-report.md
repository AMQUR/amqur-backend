# AMQUR / Dial Us Now — Final Production Readiness Report

**Updated:** 2026-07-17 (internal canary gate)  
**Branches:** `production-readiness/pilot-prep`  
**PRs (do not merge without owner approval):**  
- https://github.com/AMQUR/amqur-backend/pull/22  
- https://github.com/AMQUR/amqur-widget/pull/13  

**Verdict:** **READY FOR INTERNAL CANARY**

Production DNS (`api` / `widget`) is **not** attached. Public Team Velocity install is **not** authorized.

---

## 1. Deployed SHA vs PR verification

| Artifact | PR head (GitHub) | Staging deploy evidence | Match notes |
|----------|------------------|-------------------------|-------------|
| Backend API | PR #22 head advances with branch pushes | Railway SUCCESS deploy `c14e0b79…` (2026-07-17T00:23Z) uses `sh -c` startCommand from `5566f2b` era | Docs-only commits after deploy until canary follow-up redeploy; **redeploy required** for bootstrap lockout + `/api/health/ready` |
| Widget | PR #13 head `9ee7b4d` (+ canary e2e) | Railway SUCCESS `153b2c2f…` (2026-07-17T00:16Z) serves `assistant-widget.iife.js` 200 | Aligns with IIFE publish commit; push canary e2e after |

Railway CLI deploys do not expose git SHA in `deployment list --json` meta — match by startCommand fingerprint + deploy time.

### CI checks

| PR | Check | Result |
|----|-------|--------|
| Backend #22 | `build-test` | **FAIL** prior to canary fix — prettier error in `src/worker.ts` (fixed locally; push re-runs CI) |
| Widget #13 | `build` | **PASS** |

Missing required suites in CI (still local/manual): full Playwright matrix, staging e2e, load/soak, empty-DB migrate job.

---

## 2. Security / secrets / migrations

| Check | Result |
|-------|--------|
| Tracked `.env` / PEM / live keys | No production secrets tracked (examples only) |
| Widget IIFE secret scan | CLEAN (no JWT/DB/bootstrap/sk-ant) |
| Migrations | Additive; 7 applied on staging; local `amqur_test` migrate status clean |
| Destructive migration patterns | CI scan forbids DROP TABLE / migrate reset |
| Bootstrap | `BOOTSTRAP_SECRET` SET on staging; code now **disables after any SUPER_ADMIN**; redeploy to activate |

---

## 3. Five tenants (staging)

All return public `widget-config` 200 with inventory/payments **false**, handoff **true**:

| tenantSlug | locationSlug | Origins | Token |
|------------|--------------|---------|-------|
| jeep-of-chicago | main | empty | 403 |
| dial-nissan-of-chicago | main | empty | 403 |
| dial-chevy-of-chicago | main | empty | 403 |
| infiniti-of-chicago | main | empty | 403 |
| dial-cdjr-of-chicago | main | empty | 403 |

Owner origin table: `docs/canary/owner-website-origins.md` (do not invent domains).

---

## 4. Handoff / truthfulness

- Escalation create persists durable row; `notified`/`queued` only when CRM accept or outbox enqueue.
- Customer copy refuses “I notified the team” unless `notified`/`queued`.
- Appointment reply updated to avoid false “logged + team will reach out” without delivery proof.
- Unit gates: `auth.bootstrap`, `canary-gate`, truthfulness golden (+ expanded), failure-injection, isolation contracts — **32+ focused tests green**; expanded truthfulness suite green.

AI live suite: **NOT RUN against staging LLM** — `ANTHROPIC_API_KEY` MISSING. Instructions: `docs/canary/staging-ai-provider.md`.

---

## 5. Staging browser + load evidence (this gate)

| Suite | Result |
|-------|--------|
| Playwright Dial Us Now canary (Chromium, Firefox, WebKit, Pixel7, iPhone14) | **60 passed** against custom staging domains (after throttle cooldown) |
| Staging load `EXPECTED_PILOT` @ 40 rps | **FAIL** — Nest global throttle ~120/min correctly returns 429 (rate limit working; not capacity proof) |
| Staging load `STAGING_CANARY` @ 1.5 rps / 60s | Health 90/90 ok; residual public 429s → errorRate 0.1 — **not** ≤1% acceptance; document throttle interaction |
| Local disposable EXPECTED_PILOT (prior) | PASS — see `docs/evidence/LOCAL_VALIDATION_2026-07-16.md` |
| Monitoring / ERROR_MONITORING_DSN | **UNSET** — alert delivery **not** verified |

Evidence JSON: `backend/test/evidence/load-STAGING_CANARY-*.json`, Playwright traces on failure only.

---

## 6. Canary documentation

| Doc | Path |
|-----|------|
| Plan | `docs/canary/internal-canary-plan.md` |
| Employee script | `docs/canary/employee-test-script.md` |
| Results template | `docs/canary/results-template.md` |
| Go/no-go | `docs/canary/go-no-go-checklist.md` |
| Origins input | `docs/canary/owner-website-origins.md` |
| AI vars | `docs/canary/staging-ai-provider.md` |

---

## 7. Monitoring

| Signal | Status |
|--------|--------|
| `/api/health` db+redis | Observed ready when not rate-limited |
| ERROR_MONITORING_DSN / Sentry | MISSING — do not claim alerts |
| Railway metrics | Available in Railway UI — not wired to paging |

---

## 8. Blockers (exact)

1. Owner HTTPS origins for five rooftops (`docs/canary/owner-website-origins.md`)
2. First SUPER_ADMIN bootstrap (then secret rotation / lockout) + redeploy of bootstrap lockout commit
3. Backend CI green after prettier/bootstrap push
4. `ANTHROPIC_API_KEY` for generative canary (optional if fallbacks accepted)
5. Staging CRM webhook **or** explicit accept durable-local-only handoff
6. `ERROR_MONITORING_DSN` + proven alert delivery
7. Staging expected-pilot load acceptance under 120/min throttle (use local stack for capacity; or raise staging throttle for scheduled load window)
8. Team Velocity / store approval before public snippets
9. Production DNS — **do not attach** until limited-pilot gate

---

## 9. Production stance

- **Not** attaching `api.dialusnow.com` / `widget.dialusnow.com`
- **Not** auto-merging PRs
- Second DNS checkpoint remains PENDING in `docs/deployment/dialusnow-dns-records.md`

---

## 10. Final verdict

# READY FOR INTERNAL CANARY

**Not** READY FOR LIMITED DEALERSHIP PILOT — origins, employee canary results, monitoring, and store/TV approval remain open.  
**Not** READY FOR PUBLIC PRODUCTION.
