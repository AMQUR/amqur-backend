# AMQUR / Dial Us Now — Final Production Readiness Report

**Updated:** 2026-07-18T22:01Z (America/Chicago session)  
**Backend main:** `459342a` (includes PR #22 merge `c7627ed`)  
**Widget main:** `0221ff5` (includes PR #13 `b049b54` + CDN/canary fixes #14–#16)

## Verdict

**READY FOR INTERNAL CANARY**

| Status line | Value |
|-------------|-------|
| Production infrastructure deployed | **YES** |
| Production domains active | **NO** — Railway attached; Squarespace DNS still NXDOMAIN |
| Production SUPER_ADMIN initialized | **NO** — owner interactive bootstrap required |
| Production tenants created | **NO** — blocked on SUPER_ADMIN |
| Human canary passed | **NO** — automated staging matrix green; human results not recorded |
| Pilot rooftop installed | **NO** |
| Public dealership traffic enabled | **NO** |

---

## Evidence (observed this session)

### Repos / CI

| Item | Result |
|------|--------|
| Auth | `gh` as AMQUR; `railway` as saadimran916@gmail.com; Docker Desktop up |
| Backend working tree | clean on `main` @ `459342a` |
| Widget working tree | clean on `main` @ `0221ff5` |
| Backend CI (main tip) | **CI success**; Deploy workflow fails — `RAILWAY_TOKEN` secret absent |
| Widget CI (main tip) | **build success**; Deploy fails — `RAILWAY_TOKEN` secret absent |
| Backend local | prisma validate OK; `tsc` OK; lint 0 errors / 6 warnings; Jest **195/195** (48 suites); cov+build OK; e2e platform **33**; migration e2e **8**; full e2e **36** |
| Widget local | lint OK; Vitest **20/20**; Vite build OK |
| Widget bundle secret scan | no JWT/DB/bootstrap/private-key/DSN strings in IIFE |

### Production isolation (hashes compared; values not printed)

| Key | Staging vs production |
|-----|------------------------|
| DATABASE_URL | **different** |
| REDIS_URL | **different** |
| JWT_SECRET | **different** |
| WIDGET_TOKEN_SECRET | **different** |
| INTEGRATION_ENCRYPTION_KEY | **different** |
| BOOTSTRAP_SECRET | **different** (still PRESENT on prod — required until bootstrap) |
| prod-api ↔ prod-worker DB/Redis hashes | **match each other** |
| prod-widget secrets | **none** (Railway vars only) |
| API_MAX_REPLICAS | **1** |

### Production runtime (temporary Railway URLs)

| Check | Result |
|-------|--------|
| `prod-api` `/api/health` + `/ready` | **200** ready; database **up**; redis **up** |
| `prod-api` `/api/version` | environment=production; commitSha/buildTime/releaseId still **unknown** (stamp not wired on current deploy) |
| `prod-widget` `/assistant-widget.iife.js` | **200** |
| `prod-widget` `/version.json` | commitSha=`42225d8` (CDN fix #14) |
| `prod-widget` `/` | tenant-free CDN page (staging leak **removed**) |
| Production tenants | all five rooftops + ops → **404** (not created) |
| ERROR_MONITORING_DSN | **ABSENT** on prod-api/prod-worker |

### Staging (employee canary host)

| Check | Result |
|-------|--------|
| Staging API ready | db+redis **up**; commitSha=`27da4b5` |
| Staging widget | commitSha=`0221ff5`; canary host with `#tenant` / `#boot`; API `staging-api.dialusnow.com` |
| Automated matrix | **65/65 PASS** (`test/evidence/canary-matrix-1784412056021.json`) |
| Playwright browsers | Chromium/Firefox/WebKit + mobile — **65 passed**, 60 skipped (legacy pilot), exit 0 |

### DNS / TLS (production custom domains)

| Record | Railway expectation | Live DNS |
|--------|---------------------|----------|
| CNAME `api` → `0wcjhs75.up.railway.app` | REQUIRES_UPDATE | **NXDOMAIN** |
| CNAME `widget` → `t05fw9mw.up.railway.app` | REQUIRES_UPDATE | **NXDOMAIN** |
| TXT `_railway-verify.api` | unverified | **absent** |
| TXT `_railway-verify.widget` | unverified | **absent** |
| Certificate | VALIDATING_OWNERSHIP | **not issued** |

Exact values unchanged from Railway domain status — see `docs/deployment/dialusnow-dns-records.md`.

### Backups

| Item | Evidence |
|------|----------|
| Prod Postgres volume | `postgres-volume-UTvg` Ready (154MB/5000MB) |
| Prod Redis volume | `redis-volume-n8oT` Ready (83MB/5000MB) |
| Staging volumes | postgres + redis Ready |
| Snapshot schedule / retention / failure alerts | **NOT verified via CLI** — owner must confirm in Railway dashboard |

### Defects fixed this session

1. **prod-widget served staging pilot HTML** → fixed in widget PR #14; redeployed; verified no staging leak.
2. **staging canary host** missing tenant UI + wrong API URL → fixed in PRs #15/#16; redeployed; Playwright **65/65**.

### Not completed (owner / external gates)

1. Production SUPER_ADMIN bootstrap (interactive)
2. Squarespace DNS for production
3. ERROR_MONITORING_DSN + proven alert delivery
4. Railway Postgres snapshot schedule confirmation
5. GitHub `RAILWAY_TOKEN` + production environment reviewers
6. Human employee canary results document
7. One rooftop verified dealership data + Team Velocity approval
8. Production API redeploy with release SHA stamping
9. Five fail-closed production tenants (after SUPER_ADMIN)

---

## Allowed next actions

1. Owner runs production SUPER_ADMIN bootstrap script.
2. Owner adds the four Squarespace DNS records exactly as documented.
3. Employees run `docs/canary/employee-test-script.md` on staging host.
4. Owner provides monitoring DSN privately (not in chat/git).

Do **not** enable public dealership traffic.
