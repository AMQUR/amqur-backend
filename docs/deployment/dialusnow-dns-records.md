# dialusnow.com DNS records (Railway)

**Project:** `dial-us-now-platform` (`3bca40b6-01c6-4f02-9464-8682e6ffcb75`)  
**DNS host:** Squarespace  
**TTL during validation:** 300

Hostname checks must use **exact** equality (`hostname === "api.dialusnow.com"`), never substring matching (because `staging-api.dialusnow.com` contains `api.dialusnow.com`).

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

## Production — VERIFIED (2026-07-18T22:38Z)

Owner confirmed Squarespace records saved. Re-checked with system resolver, `8.8.8.8`, `1.1.1.1`, and Railway `domain status`.

### Traffic CNAME

| Environment | Service | Type | Name | Value | Status |
|-------------|---------|------|------|-------|--------|
| production | prod-api | CNAME | `api` | `0wcjhs75.up.railway.app` | **PROPAGATED** |
| production | prod-widget | CNAME | `widget` | `t05fw9mw.up.railway.app` | **PROPAGATED** |

### Ownership TXT

| Environment | Service | Type | Name | Value | Status |
|-------------|---------|------|------|-------|--------|
| production | prod-api | TXT | `_railway-verify.api` | `railway-verify=d7f632a8312171eab4502509ea44c2f690f2da148d9cb41ab5812f16517cda8f` | **verified** |
| production | prod-widget | TXT | `_railway-verify.widget` | `railway-verify=1789685fc6fb3d723b9481205485beb0762aa96f9fbd7ba9ded7bdcaee137ff5` | **verified** |

### TLS

| Host | Certificate CN | Issuer | Status |
|------|----------------|--------|--------|
| `api.dialusnow.com` | `api.dialusnow.com` | Let's Encrypt YR2 | **VALID** (notBefore 2026-07-18) |
| `widget.dialusnow.com` | `widget.dialusnow.com` | Let's Encrypt YR2 | **VALID** (notBefore 2026-07-18) |

### HTTPS smoke (custom domains)

| URL | Result |
|-----|--------|
| `https://api.dialusnow.com/api/health` | 200 ready |
| `https://api.dialusnow.com/api/health/ready` | 200 db+redis up |
| `https://api.dialusnow.com/api/version` | 200 environment=production |
| `https://widget.dialusnow.com/version.json` | 200 commitSha=`42225d8` |
| `https://widget.dialusnow.com/assistant-widget.iife.js` | 200 |
| Prod widget HTML staging leak | **none** |

### Temporary Railway domains (still available)

| Service | URL |
|---------|-----|
| prod-api | `https://prod-api-production-62be.up.railway.app` |
| prod-widget | `https://prod-widget-production.up.railway.app` |

## Later (document only — not deployed)

- `app.dialusnow.com`
- `docs.dialusnow.com`
- `status.dialusnow.com`
