# dialusnow.com DNS records (Railway)

**Project:** `dial-us-now-platform` (`3bca40b6-01c6-4f02-9464-8682e6ffcb75`)  
**Captured:** 2026-07-17T00:16:37Z  
**DNS host:** Squarespace (owner action required)

## Staging (attached — awaiting DNS)

### Traffic CNAME

| Host | Type | Value | Purpose |
|------|------|-------|---------|
| `staging-api` | CNAME | `w3t2i0xt.up.railway.app` | Route `staging-api.dialusnow.com` → API |
| `staging-widget` | CNAME | `db5sfivo.up.railway.app` | Route `staging-widget.dialusnow.com` → widget |

### Ownership verification TXT (required for certificates)

| Host | Type | Value |
|------|------|-------|
| `_railway-verify.staging-api` | TXT | `railway-verify=cd88e61ca89cc8f1e032d273eb175eabdde562da19d25f379381450e866f0a44` |
| `_railway-verify.staging-widget` | TXT | `railway-verify=3c104874eb66c89dd22ea60cadaa93f74f11e374d60dd6ba1d8c85773d9c935e` |

### Temporary Railway domains (use for smoke before DNS)

| Service | URL |
|---------|-----|
| api | `https://api-staging-0be0.up.railway.app` |
| widget | `https://widget-staging-55e0.up.railway.app` |

## Production (not attached yet)

Attach only after staging gate is green:

| Host | Type | Value | Status |
|------|------|-------|--------|
| `api` | CNAME | *(capture after `railway domain api.dialusnow.com`)* | PENDING |
| `widget` | CNAME | *(capture after `railway domain widget.dialusnow.com`)* | PENDING |
| `_railway-verify.api` | TXT | *(capture from Railway)* | PENDING |
| `_railway-verify.widget` | TXT | *(capture from Railway)* | PENDING |

## Later (document only — do not deploy unless required)

- `app.dialusnow.com`
- `docs.dialusnow.com`
- `status.dialusnow.com`

## MANUAL DNS CHECKPOINT — Squarespace steps

1. Sign in to Squarespace → Domains → `dialusnow.com` → DNS settings.
2. Add the four staging records above (2× CNAME traffic + 2× TXT verify).
3. TTL: use Squarespace default (or 5–30 minutes during cutover).
4. Do **not** point production `api` / `widget` yet.
5. Reply in chat: **DNS staging records added** (or paste a screenshot).
6. Only after that confirmation will we run `dig` / certificate verification.

**Paused here for owner DNS action.** Do not claim HTTPS on custom domains until verified.
