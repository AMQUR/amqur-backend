# AMQUR / Dial Us Now — Final Production Readiness Report

**Date:** 2026-07-16/17  
**Branches:** `production-readiness/pilot-prep`  
**Backend HEAD:** see `origin/production-readiness/pilot-prep` (includes DNS verification docs)  
**Widget HEAD:** `9ee7b4d`  
**PRs (do not merge without owner approval):**  
- https://github.com/AMQUR/amqur-backend/pull/22  
- https://github.com/AMQUR/amqur-widget/pull/13  

**Verdict:** **READY FOR INTERNAL CANARY**

Staging custom domains are **DNS + TLS + smoke green**. Limited dealership pilot on live rooftop sites remains blocked until verified `allowedOrigins`, contacts/CRM, and store/TV approval. Production is **not** deployed.

---

## Layer distinction

| Layer | Status |
|-------|--------|
| Local disposable | Exercised — `docs/evidence/LOCAL_VALIDATION_2026-07-16.md` |
| CI | PR checks on #22 / #13 |
| Railway staging **temp** domains | Green |
| Railway staging **custom** domains | **Green** (dig match, cert VALID, HTTPS 200) |
| Production Railway | Env exists — **not deployed / domains not attached** |

---

## 1. DNS / TLS evidence (post-checkpoint)

Verified 2026-07-17T00:28Z against `docs/deployment/dialusnow-dns-records.md`:

| Check | Result |
|-------|--------|
| `staging-api` CNAME → `w3t2i0xt.up.railway.app` | PASS (dig + Railway PROPAGATED) |
| `staging-widget` CNAME → `db5sfivo.up.railway.app` | PASS |
| TXT `_railway-verify.staging-api` | PASS (exact token match; Railway verified=true) |
| TXT `_railway-verify.staging-widget` | PASS (exact token match; Railway verified=true) |
| Certificates | both `CERTIFICATE_STATUS_TYPE_VALID` |
| `https://staging-api.dialusnow.com/api/health` | **200** `ready` (database up, redis up) |
| `https://staging-widget.dialusnow.com/assistant-widget.iife.js` | **200**, ssl_verify=0, AmqurWidgetBundle, secret scan clean |

---

## 2. Staging smoke (custom domains)

| Check | Result |
|-------|--------|
| `/api/health/live` | 200 live |
| `/api/health` | 200 ready |
| Migrate status (via Postgres public proxy) | **7 migrations, schema up to date** |
| Five tenants `widget-config` | all **200**; inventory/payments **false**; chat **true** |
| Widget-token without origins | **403** `Widget origins not configured` (fail-closed) |
| Public cross-tenant body isolation | **PASS** (no other tenantSlug leaked in responses) |
| Authenticated chat/isolation on staging | **NOT RUN** — needs SUPER_ADMIN session or widget-token after origins configured |

Tenants: `jeep-of-chicago`, `dial-nissan-of-chicago`, `dial-chevy-of-chicago`, `infiniti-of-chicago`, `dial-cdjr-of-chicago` (`main`).

---

## 3. What still needs credentials / owner input

| Item | Why |
|------|-----|
| Verified website origins per tenant | Widget-token currently 403 for all Origins |
| SUPER_ADMIN / bootstrap path | Authenticated isolation + onboarding API |
| `ANTHROPIC_API_KEY` | Live LLM on staging |
| CRM webhook | Outbound handoff notify |
| Escalation recipients / phone / address / hours | Dealership truth — must not invent |
| Team Velocity CSP/GTM approval | Production site install |
| Completed soak JSON | Local soak completion not confirmed on disk |
| Production attach | Explicit second DNS checkpoint after pilot criteria |

---

## 4. Production stance (this session)

- **Not** attaching `api.dialusnow.com` / `widget.dialusnow.com`
- **Not** deploying production services
- Second DNS checkpoint remains documented as PENDING in `dialusnow-dns-records.md`

---

## 5. Local evidence (unchanged baseline)

142 unit / 33 e2e platform / 35 Playwright / paced load SMOKE+EXPECTED_PILOT pass. Coverage ~24.5% global with gated critical modules. npm audit 14 Nest transitive. See prior evidence paths under `backend/test/evidence/`.

---

## 6. Rollback

Redeploy prior Railway deployment for api/widget/worker. Do not `migrate reset`. Keep production widget bundle untouched (not deployed).

---

## 7. Verdict rationale

| Candidate | Decision |
|-----------|----------|
| NOT READY | No — staging custom domains + fail-closed tenants work |
| **READY FOR INTERNAL CANARY** | **Yes** — use staging custom domains for internal validation |
| READY FOR LIMITED DEALERSHIP PILOT | **No yet** — no verified origins/CRM/store approval; authenticated staging isolation not executed |
| READY FOR PUBLIC PRODUCTION | No |

**Final:** **READY FOR INTERNAL CANARY**
