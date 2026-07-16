# AMQUR Final Production Readiness Report

**Date:** 2026-07-16  
**Branches:** `production-readiness/pilot-prep` (backend + widget)  
**Verdict:** **READY FOR LIMITED DEALERSHIP PILOT**

Scope of that verdict: chat + lead capture + durable handoff recording, with inventory/payments/service/parts **fail-closed** until each rooftop’s verified dependency chain is enabled. Not ready for public unattended production or inventing Tekion/vAuto endpoints.

---

## 1. Executive summary

Phase 1 audit found a solid NestJS multi-tenant chat core with critical gaps: no DealerGroup, hardcoded branding, optimistic feature flags, chat not enforcing capabilities, stalled outbox, and widget canary envelope bugs.

This branch implements dealer-group tenancy (isolation-preserving), DB-driven public branding + cache invalidation, fail-closed capability gating in API and widget, outbox processor + worker entry, authenticated idempotent onboarding, provider contracts, ops/onboarding/integration docs, isolation/truthfulness tests, and CI branch coverage.

**111** backend unit tests and **18** widget tests pass locally; typecheck/lint/build green. External systems (Railway secrets, authorized feeds, CRM webhook, Team Velocity CSP, Tekion docs) remain blockers for full inventory/CRM live mode.

---

## 2. Architecture implemented

- Shared platform; **one Tenant per rooftop**; optional **DealerGroup** + **DealerGroupMembership** for aggregate reporting only
- Authority order unchanged: verified inventory → KB → CRM/DMS/service/parts → policies → website → general AI (never overrides verified data)
- Public widget-config returns branding/features only; secrets never exposed
- CapabilityService fail-closed gates chat intents; FeatureFlags defaults fail-closed
- Escalations: webhook success → `notified`; failure → outbox queue → truthful copy (no false “notified”)
- Optional Redis config cache; readiness requires DB, not Redis
- Railway Dockerfile path + migrate-on-start; worker process for outbox

---

## 3. Files changed (summary)

### Backend
- Prisma: `DealerGroup`, memberships, `Tenant.publicConfig/configVersion/dataRetentionDays/consentText`, `Location.publicConfig/escalationRecipients`
- Modules: `onboarding`, `dealer-groups`, `capability`, `cache`, outbox processor, worker entry
- Chat/escalations/feature-flags/public/health/env validation updates
- Docs under `backend/docs/{deployment,operations,onboarding,integrations,vendor-handoff}`
- Tests: branding, capability, isolation contracts, truthfulness golden, policy defaults

### Widget
- Fail-closed feature UI; bootstrap keeps `proactive`/`locales`/consent/configVersion
- Canary loader + redeem unwrap Nest `{ data }`
- CDN stub warns if published; vendor test host page
- Docs vendor-handoff copy

### Workspace
- `docs/production-readiness-audit.md`, `docs/final-production-readiness-report.md`, deployment/ops/onboarding/integration docs, `.env.production.example`

---

## 4. Database migrations created

| Migration | Purpose |
|-----------|---------|
| `20260716200000_dealer_group_branding_config` | DealerGroup + memberships; tenant/location public config; retention/consent; escalation recipients |

Non-destructive (additive). Rollback: drop new columns/tables after code rollback (expand/contract preferred).

---

## 5. Tests added

- `public-branding.spec.ts`
- `capability.service.spec.ts`
- `tenant-isolation.e2e-style.spec.ts`
- `truthfulness-golden.spec.ts`
- Staging policy: fail-closed defaults assertion
- Escalations unit tests updated for outbox dependency

---

## 6. Exact test commands

```bash
# Backend
cd /Users/saad/Downloads/amqur-platform/backend
npm ci
npx prisma generate
npm run typecheck
npm test
npm run test:cov   # optional
npm run build
# optional with disposable Postgres:
# npm run test:e2e

# Widget
cd /Users/saad/Downloads/amqur-platform/amqur-widget
npm ci
npm run lint
npm test
npm run build
# optional staging Playwright when env set:
# npm run test:staging

# Local load smoke (API must be running locally — not production)
# BASE_URL=http://127.0.0.1:3000/api DURATION_SEC=10 CONCURRENCY=10 node scripts/load-smoke.js
```

---

## 7. Test results and coverage

| Suite | Result |
|-------|--------|
| Backend `npm run typecheck` | PASS |
| Backend `npm test` | **36 suites / 111 tests PASS** |
| Backend `npm run build` | PASS |
| Widget `npm run lint` | PASS |
| Widget `npm test` | **4 files / 18 tests PASS** |
| Widget `npm run build` | PASS (IIFE ~614KB) |
| Backend e2e | Not run this session (requires disposable DB) |
| Playwright staging | Not run (requires staging URLs) |
| `test:cov` | Not collected this session — run `npm run test:cov` for HTML report |

---

## 8. Load/soak results

Load script added: `backend/scripts/load-smoke.js`.  
**Not executed against a live server in this session** (no local API process assumed). Run before pilot against staging only; never against production CRM/inventory vendors.

---

## 9. Security findings

| Severity | Finding | Status |
|----------|---------|--------|
| Critical | Chat ignored feature flags | **Fixed** (CapabilityService) |
| Critical | No DealerGroup / group auth | **Fixed** (membership required) |
| Critical | Canary eligibility envelope | **Fixed** (unwrap data) |
| High | Optimistic feature defaults | **Fixed** (fail-closed) |
| High | Hardcoded branding | **Fixed** (DB publicConfig) |
| High | Outbox without processor | **Fixed** (cron + worker) |
| Medium | Bootstrap body secret | Residual — clear `BOOTSTRAP_SECRET` after use |
| Medium | Secret vault unused for live Tekion | Residual until partner enablement |
| Medium | Circuit breaker underused | Residual — wire on live adapters |
| Info | Local `.env.production` on disk | Untracked; rotate if shared machine |

---

## 10. Remaining external blockers

1. Authorized vAuto/inventory feed URLs per rooftop  
2. CRM webhook or Tekion sandbox credentials + official docs  
3. Railway project + Postgres/Redis + domains  
4. Team Velocity / CMS CSP + embed approval  
5. Production Anthropic key (optional polish)  
6. Legal verification before any fifth Dial rooftop  
7. Employee canary GTM publish access (historical blocker)

---

## 11. Required Railway setup

- Service `api` (Dockerfile, migrate + `node dist/main.js`)
- Service `worker` (`node dist/worker.js`)
- Postgres plugin → `DATABASE_URL`
- Redis plugin → `REDIS_URL` (optional)
- Env from `.env.production.example`
- Public domain for API; private networking for DB/Redis

---

## 12. Required DNS records

| Record | Target |
|--------|--------|
| `api.<domain>` | Railway API |
| CDN hostname for widget IIFE | Object storage / CDN |
| Dealership site origins | Already dealer-owned; must match `allowedOrigins` |

Exact hostnames: confirm with ops (not invented here).

---

## 13. Required secrets

`DATABASE_URL`, `JWT_SECRET` (≥32), `INTEGRATION_ENCRYPTION_KEY` (≥32 before storing vendor secrets), `CORS_ORIGINS`, optional `REDIS_URL`, `CRM_WEBHOOK_URL`, `ANTHROPIC_API_KEY`, canary secrets if employee mode, feed allowlist hosts. Never commit values.

---

## 14. Required Team Velocity information

- Production script-src / connect-src CSP allowlists  
- Approved embed snippet placement (GTM vs theme)  
- Confirmation Shadow DOM + delayed load acceptable  
- Staging vs production asset URLs  
- Contact for emergency kill-switch publish

---

## 15. Required Tekion information

See `docs/integrations/tekion-readiness.md` — official API docs, sandbox credentials, dealer IDs, webhook signing, DPA, written approval before `liveReady=true`. **No endpoints invented.**

---

## 16. Required vAuto information

See `docs/integrations/vauto-readiness.md` — authorized feed URL/format per rooftop, min records, freshness SLA, host allowlist. **No public API invented.**

---

## 17. Per-dealership onboarding steps

1. Collect verified store data (see `docs/onboarding/data-collection.md`)  
2. `POST /api/onboarding/dealership` as SUPER_ADMIN **or** `npm run onboard:dealership -- --config ...`  
3. Set `allowedOrigins` to production HTTPS origins only  
4. Keep inventory/payments flags false until feed + fresh vehicles verified  
5. Configure `CRM_WEBHOOK_URL` or accept truthful “not notified” handoff copy  
6. Staff UAT on staging → limited pilot  
7. Use `docs/onboarding/checklist.md`

Example: `docs/onboarding/dial-auto-group.example.json`

---

## 18. Deployment steps

1. Merge green CI on `production-readiness/pilot-prep`  
2. Deploy API (migrate) + worker on Railway  
3. Publish versioned `amqur-widget.iife.js` to CDN (never `cdn/amqur-widget.js` stub)  
4. Onboard rooftops; set origins  
5. Smoke: widget-config → token → chat → handoff escalation visible to staff  
6. Enable inventory only after successful import run

---

## 19. Rollback steps

1. Redeploy previous Railway deployment for api/worker  
2. Feature-flag disable (`chat`/`inventory`/etc.) immediately if needed  
3. Canary kill query `amqur_canary_kill=1`  
4. Do not auto-revert additive migrations in panic; leave columns unused  
5. Restore prior CDN object version for widget

---

## 20. Final readiness verdict

# READY FOR LIMITED DEALERSHIP PILOT

**Not** READY FOR PUBLIC PRODUCTION.  
Internal canary is also supported once employee canary secrets/origins are configured.

### Gate evidence (abbreviated)

| # | Gate | Evidence |
|---|------|----------|
| 1 | No fabricated dealership data | Truth engine + fail-closed capabilities + golden tests |
| 2 | Multi-tenant isolation | Schema indexes + group membership checks + isolation tests |
| 3 | DealerGroup without weakening isolation | Aggregate reporting only |
| 4 | Data-driven branding | `publicConfig` + public.service |
| 5 | Fail-closed features | PLATFORM_FEATURE_DEFAULTS + CapabilityService + widget `=== true` |
| 6 | Truthful handoff | notified/queued/durable-only copy |
| 7 | Outbox/DLQ | Processor + DEAD after 8 attempts |
| 8 | Health/readiness | DB required; Redis optional |
| 9 | Secrets not tracked | gitignore + CI scan |
| 10 | Docs | audit, deployment, ops, onboarding, integrations |
| 11–20 | CI, worker, provider contracts, vendor handoff, tests green | this branch |

---

*Report mirrors the parent-agent deliverable checklist.*
