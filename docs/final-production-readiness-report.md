# AMQUR / Dial Us Now — Final Production Readiness Report

**Date:** 2026-07-16 (America/Chicago) / 2026-07-17 UTC  
**Branches:** `production-readiness/pilot-prep`  
**Backend HEAD (pushed):** `5566f2b`  
**Widget HEAD (pushed):** `9ee7b4d`  
**PRs (do not merge without owner approval):**  
- https://github.com/AMQUR/amqur-backend/pull/22  
- https://github.com/AMQUR/amqur-widget/pull/13  

**Verdict:** **READY FOR INTERNAL CANARY**

Not `READY FOR LIMITED DEALERSHIP PILOT` until staging custom domains have owner-confirmed DNS + valid HTTPS, dealership origins/contacts are verified, and a staging smoke on those domains passes. Not `READY FOR PUBLIC PRODUCTION`.

---

## Layer distinction (do not conflate)

| Layer | Status |
|-------|--------|
| Local disposable (`amqur-test`) | Exercised — see `docs/evidence/LOCAL_VALIDATION_2026-07-16.md` |
| CI (GitHub Actions on PRs) | Triggered by push; treat PR checks as source of truth |
| Railway staging (temp domains) | **API + worker + widget SUCCESS**; DB migrate up to date; five tenants onboarded fail-closed |
| Staging custom domains | **Attached in Railway; DNS NOT confirmed** — MANUAL CHECKPOINT |
| Production Railway env | Exists empty — **not deployed** |
| Production custom domains | **Not attached** |

---

## 1. Executive summary

Dial Us Now staging infrastructure is live on Railway project `dial-us-now-platform` with isolated `staging` / `production` environments. Temporary domains smoke green (API ready with Postgres+Redis; widget serves `assistant-widget.iife.js`; worker healthy). Five rooftop tenants exist fail-closed (inventory/payments/service/parts off). Custom DNS at Squarespace is the next owner gate. Production must not proceed until staging custom domains validate.

---

## 2. Architecture (implemented)

- Multi-tenant NestJS API; optional DealerGroup for reporting only
- Fail-closed capabilities; truthful handoff (notified / queued / durable-only)
- Widget public filename `assistant-widget.iife.js`; API `window.AMQUR.init` unchanged
- Branding/origins via tenant config — not hardcoded Dial Us Now into core logic
- Worker process with liveness HTTP for Railway healthchecks

---

## 3. Railway staging (verified this session)

| Item | Value |
|------|-------|
| Project | `dial-us-now-platform` / `3bca40b6-01c6-4f02-9464-8682e6ffcb75` |
| Environment | `staging` / `e89573c2-55bd-409b-aa03-9c858feefe77` |
| Services | api, worker, widget, Postgres, Redis |
| Temp API | `https://api-staging-0be0.up.railway.app` — `/api/health` **ready** (db up, redis up) |
| Temp widget | `https://widget-staging-55e0.up.railway.app/assistant-widget.iife.js` — **200** (~614KB, `AmqurWidgetBundle`) |
| Migrate | `prisma migrate status` via public proxy — **7 migrations, schema up to date** |
| Worker | Deploy **SUCCESS** (`2a48ac9b…`) |

### Five tenants (staging DB)

| tenantSlug | locationSlug | widget-config | Features |
|------------|--------------|---------------|----------|
| jeep-of-chicago | main | 200 | chat/handoff/leadCapture on; inventory/payments off |
| dial-nissan-of-chicago | main | 200 | same |
| dial-chevy-of-chicago | main | 200 | same |
| infiniti-of-chicago | main | 200 | same |
| dial-cdjr-of-chicago | main | 200 | same |

`allowedOrigins` empty until owner supplies verified websites — widget-token from arbitrary origins should remain reject/fail-closed until origins are set.

---

## 4. Local test evidence (re-run baseline)

See `docs/evidence/LOCAL_VALIDATION_2026-07-16.md` and `backend/test/evidence/`.

| Check | Result |
|-------|--------|
| Unit | **39 suites / 142 tests** PASS |
| Coverage | thresholds PASS — ~**24.5%** global lines; critical modules gated |
| E2E platform | **33 tests** PASS |
| Widget unit | **18 tests** PASS |
| Playwright matrix | **35 tests** PASS (Chromium/Firefox/WebKit + mobile) |
| Load SMOKE / EXPECTED_PILOT | PASS 0% errors (paced) |
| BURST | Expected rate-limit degradation |
| Soak ≥30 min | Started multiple times; **JSON completion artifact not confirmed on disk this session** — do not claim staging soak green |
| Secret scans | CLEAN |
| npm audit (prod) | **14** transitive highs/moderates via Nest — no destructive `audit fix` |

---

## 5. Security / audit notes

- Prior Critical/High code gaps (fail-closed flags, branding, outbox, isolation) addressed on this branch
- Staging secrets generated and set in Railway (names only in `docs/deployment/staging-environment-values.md`)
- Do not commit secret values; `DATABASE_PUBLIC_URL` used only for one-shot migrate status / onboard from laptop — prefer private URL in-app
- Postgres/Redis remain private-network primary; public DB URL is for ops break-glass only

---

## 6. Remaining blockers

1. **MANUAL DNS** — Squarespace records in `docs/deployment/dialusnow-dns-records.md` (owner)
2. Verified dealership websites/phones/hours/CRM/escalation recipients (see `docs/onboarding/verification-matrix.md`)
3. `ANTHROPIC_API_KEY` for staging LLM (owner)
4. CRM webhook when authorized
5. Team Velocity CSP/GTM approval per rooftop
6. Tekion / vAuto — disabled; readiness docs only
7. Production deploy — **blocked** until staging custom domains + validation green
8. Completed local soak JSON evidence (re-run if required for pilot gate)
9. Nest transitive npm audit findings (multer / path-to-regexp / qs)

---

## 7. DNS checkpoint (staging)

Exact records: `docs/deployment/dialusnow-dns-records.md`.  
**Paused for owner Squarespace action.** Do not run dig/cert verify until owner confirms.

---

## 8. Rollback

- Railway: redeploy previous successful deployment for `api` / `widget` / `worker`
- Widget: keep versioned IIFE; do not overwrite production bundle from this branch
- DB: additive migrations only; rollback = code rollback + expand/contract column drop if needed
- Do **not** `prisma migrate reset` on staging/production

---

## 9. Final readiness verdict

**READY FOR INTERNAL CANARY**

Allowed use: internal validation against Railway temporary staging domains and fail-closed tenants.  
Not approved: dealership website installs on production hosts, production Railway deploy, or public unattended traffic.
