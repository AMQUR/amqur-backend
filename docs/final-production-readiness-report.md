# AMQUR / Dial Us Now — Final Production Readiness Report

**Updated:** 2026-07-17T16:50Z  
**Backend main:** `c7627ed` (PR #22 squash-merged)  
**Widget main:** `b049b54` (PR #13 squash-merged)

## Verdict

**READY FOR INTERNAL CANARY**

| Status line | Value |
|-------------|-------|
| Production infrastructure deployed | **YES** (isolated Postgres/Redis + prod-api/prod-worker/prod-widget) |
| Production domains active | **NO** — Railway attached; Squarespace DNS pending |
| Public dealership traffic enabled | **NO** |

---

## Evidence summary

### Merges / CI

| Item | Result |
|------|--------|
| Backend PR #22 | **MERGED** → `c7627ed` |
| Widget PR #13 | **MERGED** → `b049b54` |
| Backend CI at merge | build-test / docker-build / migrations-empty-db **PASS** |
| Widget CI | build **PASS** (staging-e2e skipped without secrets) |
| Local backend Jest | **195/195** |
| Local widget Vitest | **20/20** + production build |

### Staging alignment

| Item | Result |
|------|--------|
| Staging API commit | `27da4b5` (runtime); later branch commits were docs/ops/CI only before merge |
| Staging widget commit | `91db0d9` |
| Staging health | ready (db+redis) |
| Staging five-tenant matrix | previously **65/65** (reported) |

### Production Railway (`dial-us-now-platform` / env `production`)

| Service | Status |
|---------|--------|
| Postgres-RfDb | Online (private) |
| Redis-iqMb | Online (private) |
| prod-api | Deployed SUCCESS; temp `https://prod-api-production-62be.up.railway.app` |
| prod-worker | Deploying/SUCCESS after api |
| prod-widget | SUCCESS; temp `https://prod-widget-production.up.railway.app` |

**DB/Redis:** `DATABASE_URL` resolves to `postgres-rfdb.railway.internal` (not staging).  
**Secrets:** fresh JWT / widget / encryption / bootstrap set via stdin (never printed in success path).  
**Replicas:** `API_MAX_REPLICAS=1` — in-memory throttler not multi-replica safe yet.

### Production smoke (temp domains)

| Check | Result |
|-------|--------|
| `GET /api/health` | **200 ready** (database up, redis up) |
| `GET /api/health/live` | **200** |
| `GET /api/version` | 200 — `environment=production` (commitSha currently `unknown` until provenance stamp wired on prod-*) |
| Widget IIFE | **200** (~614KB) |
| Dealership tenants | **404** — not onboarded until SUPER_ADMIN |
| Inventory/payments | remain platform fail-closed defaults |

### Production custom domains (Railway)

Exact DNS required — see `docs/deployment/dialusnow-dns-records.md`:

| Host | Type | Value |
|------|------|-------|
| `api` | CNAME | `0wcjhs75.up.railway.app` |
| `widget` | CNAME | `t05fw9mw.up.railway.app` |
| `_railway-verify.api` | TXT | `railway-verify=d7f632a8312171eab4502509ea44c2f690f2da148d9cb41ab5812f16517cda8f` |
| `_railway-verify.widget` | TXT | `railway-verify=1789685fc6fb3d723b9481205485beb0762aa96f9fbd7ba9ded7bdcaee137ff5` |

### Gates still open

1. **Owner:** Squarespace production DNS (checkpoint below)  
2. **Owner:** interactive production SUPER_ADMIN bootstrap (`docs/operations/owner-checkpoints.md`)  
3. Production five fail-closed tenants (blocked on #2)  
4. `ERROR_MONITORING_DSN` + alert-delivery proof  
5. Railway backup snapshot schedule UI confirmation  
6. Human employee canary results  
7. Verified dealership origins (keep empty)  
8. Redis-backed throttler before horizontal scale  
9. Team Velocity / store approval before public install  

### Security note

A failed sandboxed Railway CLI attempt briefly echoed generated secret values in an error argv dump; those values were **not** applied to Railway. Production secrets were regenerated via stdin on `prod-api` / `prod-worker` afterward. Treat any previously displayed values as compromised and unused.

---

## Allowed status lines

- Production infrastructure deployed: **YES**  
- Production domains active: **NO** (pending DNS)  
- Public dealership traffic enabled: **NO**  

**Final verdict: READY FOR INTERNAL CANARY**
