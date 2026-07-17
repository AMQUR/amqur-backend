# dialusnow.com DNS records (Railway)

**Project:** `dial-us-now-platform` (`3bca40b6-01c6-4f02-9464-8682e6ffcb75`)  
**Captured:** 2026-07-17T00:16:37Z  
**Owner confirmed Squarespace add:** 2026-07-16 (local)  
**Verified (dig + Railway):** 2026-07-17T00:28:43Z  

## Staging — VERIFIED

### Traffic CNAME

| Host | Type | Required value | dig / Railway current | Status |
|------|------|----------------|----------------------|--------|
| `staging-api` | CNAME | `w3t2i0xt.up.railway.app` | `w3t2i0xt.up.railway.app` | **PROPAGATED** |
| `staging-widget` | CNAME | `db5sfivo.up.railway.app` | `db5sfivo.up.railway.app` | **PROPAGATED** |

### Ownership verification TXT

| Host | Type | Required value | dig result | Railway verified |
|------|------|----------------|------------|------------------|
| `_railway-verify.staging-api` | TXT | `railway-verify=cd88e61ca89cc8f1e032d273eb175eabdde562da19d25f379381450e866f0a44` | match | **true** |
| `_railway-verify.staging-widget` | TXT | `railway-verify=3c104874eb66c89dd22ea60cadaa93f74f11e374d60dd6ba1d8c85773d9c935e` | match | **true** |

### Certificates / HTTPS

| Domain | Certificate (Railway) | HTTPS smoke |
|--------|----------------------|-------------|
| `staging-api.dialusnow.com` | `CERTIFICATE_STATUS_TYPE_VALID` | `GET /api/health` **200 ready** (db+redis) |
| `staging-widget.dialusnow.com` | `CERTIFICATE_STATUS_TYPE_VALID` | `GET /assistant-widget.iife.js` **200** (~614KB, `AmqurWidgetBundle`) |

### Temporary Railway domains (still valid fallback)

| Service | URL | Status |
|---------|-----|--------|
| api | `https://api-staging-0be0.up.railway.app` | healthy |
| widget | `https://widget-staging-55e0.up.railway.app` | healthy |

## Production — NOT ATTACHED (second checkpoint)

Do not add production DNS until owner approves production gate after staging validation sign-off.

| Host | Type | Value | Status |
|------|------|-------|--------|
| `api` | CNAME | *(capture after `railway domain api.dialusnow.com`)* | **PENDING — not attached** |
| `widget` | CNAME | *(capture after `railway domain widget.dialusnow.com`)* | **PENDING — not attached** |
| `_railway-verify.api` | TXT | *(capture from Railway)* | **PENDING** |
| `_railway-verify.widget` | TXT | *(capture from Railway)* | **PENDING** |

## Later (document only)

- `app.dialusnow.com`
- `docs.dialusnow.com`
- `status.dialusnow.com`

## Checkpoint history

1. ~~Owner adds staging Squarespace records~~ **done**
2. ~~dig + Railway cert + HTTPS verify~~ **done 2026-07-17T00:28Z**
3. Production domain attach + Squarespace prod records — **not started**
