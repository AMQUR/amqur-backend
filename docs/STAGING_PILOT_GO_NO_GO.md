# AMQUR Staging Pilot — Go / No-Go Report

**Date:** 2026-07-11  
**Scope:** Controlled Dial Auto Group single-rooftop **internal staging** pilot  
**Branches:** `ops/staging-pilot-automation` (backend + widget)  
**Production:** not touched

---

## Infrastructure

| Item | Value |
|---|---|
| Railway project name | `amqur-platform-staging` |
| Railway project ID (redacted form) | `e4d54510-…-a19a5ad5132c` |
| Environment | `staging` (`b58a4e5f-…-4874887c788e`) |
| backend-staging service | `a7adf0dd-…-cc95f3a63673` |
| widget-staging service | `a645c67c-…-b5c8a87ccb18` |
| postgres-staging | `a659768b-…-c39e28fdd2f8` (public proxy host `tokaido.proxy.rlwy.net`) |
| redis-staging | `40168564-…-d66a0da4c3d6` |
| Staging API URL | https://backend-staging-staging-b699.up.railway.app |
| Staging widget URL | https://widget-staging-staging.up.railway.app |
| Backend deployment | `85dd1a42-…` SUCCESS @ 2026-07-11 14:43 CT |
| Widget deployment | `bb2b48c9-…` SUCCESS @ 2026-07-11 14:56 CT |
| Backend branch tip | `c5a5c08519d4cc806636e460cd880897019dbd41` |
| Widget branch tip | `e892887` (CI green; includes Vite/Playwright CI fixes) |

**Explicitly unused:** `divine-integrity` (unlabeled / non-staging), `distinguished-laughter`, Dial Auto Group live domains.

Keychain labels (values not recorded): `AMQUR Staging JWT`, `AMQUR Staging Bootstrap`.

---

## Git

### Backend (`AMQUR/amqur-backend`)

| Item | Status |
|---|---|
| Branch | `ops/staging-pilot-automation` |
| Base | `main` (merged hardening + Tekion/vAuto foundations) |
| Commit | `c5a5c08519d4cc806636e460cd880897019dbd41` |
| Pushed | yes |
| PR | https://github.com/AMQUR/amqur-backend/pull/3 |
| CI | success |
| Uncommitted after push | report-only follow-ups may exist |

### Widget (`AMQUR/amqur-widget`)

| Item | Status |
|---|---|
| Branch | `ops/staging-pilot-automation` |
| Base | `main` |
| Commit | `e892887` (CI green) |
| Pushed | yes |
| PR | https://github.com/AMQUR/amqur-widget/pull/3 |
| CI | success |

---

## Database

| Check | Result |
|---|---|
| Identity | Staging Postgres in `amqur-platform-staging` / env `staging`; host `tokaido.proxy.rlwy.net` (not `mainline`) |
| Migration status | Up to date (`prisma migrate deploy` / resolve applied for 5 migrations) |
| Destructive scan | PASSED — no DROP/TRUNCATE/reset used |
| Seed | PASSED — idempotent `seed-staging-pilot` |
| Tenant | `dial-auto-group-staging` |
| Location | `pilot-rooftop` |
| Fixture vehicles | stocks `STG1001`/`STG1002`, VINs `1C4RJFBG0JC123456` / `1C4RJFAG5PC654321`, source `staging_fixture` |
| allowedOrigins | `https://widget-staging-staging.up.railway.app` |

---

## Redis and queues

| Check | Result |
|---|---|
| REDIS_URL wired | PASSED (`${{Redis.REDIS_URL}}` on backend-staging) |
| App Redis usage | Limited (no separate worker service); `INVENTORY_SYNC_ENABLED=false` |
| Queue / DLQ | N/A as dedicated workers — single Nest instance |
| Constraint | **Single-instance staging** — metrics are process-local |

---

## Backend verification

| Check | Result |
|---|---|
| Local npm ci / prisma / typecheck / unit+integration tests / build | PASSED (prior + widget-auth fail-closed suite 5/5) |
| Dependency audit | INFO only (no blocking install failure) |
| Secret scan (tracked) | PASSED |
| Migration destructive scan | PASSED |
| Runtime health `/api/health/live` | PASSED 200 |
| Runtime health `/api/health` database | PASSED up |
| Metrics access policy | PASSED 401 without staff token |
| Widget token permitted origin | PASSED 201 |
| Widget token evil origin | PASSED 403 |
| Widget token missing origin | PASSED 403 |
| Empty allowlist fail-open | **FIXED** — empty `allowedOrigins` now Forbidden |
| CORS widget origin | PASSED `access-control-allow-origin` present |
| Bootstrap after clear | PASSED 403 `Bootstrap is disabled` |
| Chat truthfulness (stock/VIN/appointments/Tekion/APR/parts) | PASSED — no forbidden claim strings |
| Tekion / live vAuto / outbound | DISABLED |

---

## Widget verification

| Check | Result |
|---|---|
| Build | PASSED |
| Deploy (nginx staging host) | PASSED |
| MIME `amqur-widget.iife.js` | `application/javascript` + short cache |
| Banner | `STAGING — NOT FOR CUSTOMERS` |
| IIFE `var AMQUR=` overwrite bug | **FIXED** — lib name `AmqurWidgetBundle` |
| Playwright staging suite | **12 passed** |
| Mobile viewport | PASSED |
| Escape | PASSED (page stable, widget still ready) |
| Secret scan in page/IIFE | PASSED |
| Token-origin restrictions | PASSED (API + browser) |

---

## Feature flags

### Enabled (pilot fixtures)
`chat`, `inventory`, `payments`, `vehicleCompare`, `savedVehicles`, `leadCapture`, `financeCalculator`, `serviceAi`, `partsAi`, `multilingual`, `handoff`, `leadScoring`, `copilot`

### Disabled
`tekionIntegration`, `automatedFollowup`, `voiceAi`, `proactiveEngagement`, `priceDropAlerts`, `crossStoreInventory`, live `vAutoFeed`, live appointment confirmation, CRM writeback, outbound messaging

Env: `INVENTORY_SYNC_ENABLED=false`, empty Anthropic key (Claude disabled warn at boot — expected).

---

## Truth-engine verification

| Claim under test | Outcome |
|---|---|
| Vehicle currently available (fabricated) | No unsupported “ready for pickup” on miss search |
| Appointment confirmed | Not asserted as confirmed in chat replies |
| Tekion lead created | Not claimed |
| Repair completed / ready for pickup | Not claimed |
| Final APR / final monthly payment | Not claimed |
| Part available today | Asks for VIN/part; staff verification language |
| Fixture stock/VIN paths | Chat 201; no Tekion confirmation language |

---

## External blockers

None remaining for **internal staging testing**.

Notes (non-blocking):
- Anthropic key unset → deterministic/fallback chat paths (acceptable for staging pilot)
- No separate Redis worker process; single Railway replica
- `/api/health/ready` path not implemented (use `/api/health`)

---

## Rollback

Tested / documented commands (`scripts/rollback-staging.sh`):

```bash
# List revisions
./scripts/rollback-staging.sh list-backend
./scripts/rollback-staging.sh list-widget

# Redeploy previous service revision (Railway UI or redeploy prior deployment ID)
railway environment staging
railway redeploy --service backend-staging -y   # or specific prior deployment
railway redeploy --service widget-staging -y

# Feature flags: re-seed with flags false / update featureFlags JSON
# Do NOT migrate reset / DROP / TRUNCATE
# Disable site: remove Railway domain or redeploy empty hold page
```

Additive migrations stay in place; roll back application images only.

---

## Verdict

**GO FOR INTERNAL STAGING TESTING**
