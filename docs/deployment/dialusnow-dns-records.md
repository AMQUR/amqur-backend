# dialusnow.com DNS records (Railway)

**Project:** `dial-us-now-platform` (`3bca40b6-01c6-4f02-9464-8682e6ffcb75`)  
**DNS host:** Squarespace  
**TTL during validation:** 300

## Staging — VERIFIED

### Traffic CNAME

| Environment | Service | Type | Name | Value | Status |
|-------------|---------|------|------|-------|--------|
| staging | api | CNAME | `staging-api` | `w3t2i0xt.up.railway.app` | VERIFIED |
| staging | widget | CNAME | `staging-widget` | `db5sfivo.up.railway.app` | VERIFIED |

### Ownership TXT

| Environment | Service | Type | Name | Value | Status |
|-------------|---------|------|------|-------|--------|
| staging | api | TXT | `_railway-verify.staging-api` | `railway-verify=cd88e61ca89cc8f1e032d273eb175eabdde562da19d25f379381450e866f0a44` | VERIFIED |
| staging | widget | TXT | `_railway-verify.staging-widget` | `railway-verify=3c104874eb66c89dd22ea60cadaa93f74f11e374d60dd6ba1d8c85773d9c935e` | VERIFIED |

## Production — ATTACHED IN RAILWAY (awaiting Squarespace DNS)

Captured 2026-07-17T16:48:17Z from Railway `customDomainCreate` — **do not invent or alter values**.

### Traffic CNAME

| Environment | Service | Type | Name | Value | Status |
|-------------|---------|------|------|-------|--------|
| production | prod-api | CNAME | `api` | `0wcjhs75.up.railway.app` | REQUIRES_UPDATE |
| production | prod-widget | CNAME | `widget` | `t05fw9mw.up.railway.app` | REQUIRES_UPDATE |

### Ownership TXT

| Environment | Service | Type | Name | Value | Status |
|-------------|---------|------|------|-------|--------|
| production | prod-api | TXT | `_railway-verify.api` | `railway-verify=d7f632a8312171eab4502509ea44c2f690f2da148d9cb41ab5812f16517cda8f` | unverified |
| production | prod-widget | TXT | `_railway-verify.widget` | `railway-verify=1789685fc6fb3d723b9481205485beb0762aa96f9fbd7ba9ded7bdcaee137ff5` | unverified |

### Temporary Railway domains (smoke before DNS)

| Service | URL | Evidence |
|---------|-----|----------|
| prod-api | `https://prod-api-production-62be.up.railway.app` | `/api/health` 200 ready (db+redis) 2026-07-17T16:48Z |
| prod-widget | `https://prod-widget-production.up.railway.app` | `/assistant-widget.iife.js` 200 |

## MANUAL DNS CHECKPOINT (Squarespace → dialusnow.com)

1. Open Domains → dialusnow.com → DNS → Custom Records.
2. Add the four production rows above exactly (CNAME + TXT).
3. Do not delete staging or email records.
4. Save.
5. Reply: **DNS production records added**

## Later (document only — not deployed)

- `app.dialusnow.com`
- `docs.dialusnow.com`
- `status.dialusnow.com`
