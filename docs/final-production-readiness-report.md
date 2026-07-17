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

---

## 11. Session re-verification (2026-07-16, local sandbox)

**Verified branch HEADs (local working tree):**

| Repo | Branch | HEAD SHA |
|------|--------|----------|
| backend (`AMQUR/amqur-backend`) | `production-readiness/pilot-prep` | `8c82ec0adc944f883d27c6aac90e3dd67065d4c1` |
| widget (`AMQUR/amqur-widget`) | `production-readiness/pilot-prep` | `08a217c1d7351569b87e990d507bf9b69c99e05c` |

**Local CI evidence (offline-safe suites):**

| Check | Repo | Result |
|-------|------|--------|
| `tsc --noEmit` typecheck | backend | **PASS** (exit 0) |
| `eslint` | backend | **PASS** — 0 errors, 6 unused-var warnings |
| `jest` unit | backend | **PASS — 157/157 tests, 41/41 suites** |
| `eslint` | widget | **PASS** (exit 0) |

**Not runnable in this sandbox (environment, not code):** backend `npm test` prints a trailing Prisma engine-mismatch teardown error and the widget `npm run build` fails with a rollup native-module error — both because `node_modules` was installed on macOS (`darwin-arm64`) and this build sandbox is `linux-arm64`. Migration/e2e-against-DB, Playwright, and load/soak suites therefore did not run here. Run these on the Mac (matching native binaries) or in Railway/CI.

**Uncommitted working-tree changes (backend):** the five `docs/onboarding/tenants/*.staging.json` files add `allowedOrigins: ["https://staging-widget.dialusnow.com"]` (matches the applied staging state) and are not yet committed; plus two untracked `test/evidence/load-*.json` artifacts. No secrets in the diff.

**Sandbox limitation (historical, superseded):** the sandbox session above was network-isolated with no `gh`, no `railway`, and no git push credentials. A follow-up session on the owner's Mac (2026-07-16, `darwin-arm64`) has authenticated `gh` (AMQUR) and `railway` CLIs available; deploy/secret-rotation/live-HTTP phases proceed there.

**Correction (2026-07-16, Mac session):** on the Mac, `tsc --noEmit` at `8c82ec0` actually FAILED with 8 pre-existing errors (Prisma JSON input types in `scripts/onboard-dealership.ts`, literal-type comparisons in `src/eval/canary-gate.spec.ts`) — an earlier PASS claim was an artifact of piping tsc output through `tail`, which masked the exit code. The sandbox PASS table above is therefore unreliable for typecheck. All 8 errors plus 10 pre-existing prettier errors in `scripts/*.mjs` / `test-infra/mocks/*.mjs` are fixed in the public-contract cleanup commit; verified clean afterwards: `tsc` exit 0, `eslint` exit 0 (6 unused-var warnings), `jest` 166/166 (42 suites).
