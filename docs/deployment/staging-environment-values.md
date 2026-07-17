# Staging environment values — Dial Us Now

**Project:** `dial-us-now-platform`  
**Environment:** `staging`  
**Rule:** This file lists **names and status only**. Never commit secret values.

## Services

| Service | Role | Public |
|---------|------|--------|
| api | NestJS API (`PROCESS_ROLE=api`) | HTTPS (Railway + custom domain) |
| worker | Outbox processor (`PROCESS_ROLE=worker`) | Private (no public domain) |
| widget | Static nginx host for `assistant-widget.iife.js` | HTTPS |
| Postgres | Primary DB | **Private only** — use `Postgres.DATABASE_URL` |
| Redis | Config cache | **Private only** — use `Redis.REDIS_URL` |

## API variables

| Name | Status | Notes |
|------|--------|-------|
| DATABASE_URL | SET (ref Postgres) | Private network URL |
| REDIS_URL | SET (ref Redis) | Optional; API degrades if down |
| JWT_SECRET | SET | Generated; rotate via owner |
| BOOTSTRAP_SECRET | SET | Generated; for /api/auth/bootstrap only |
| INTEGRATION_ENCRYPTION_KEY | SET | Generated; required before storing live credentials |
| NODE_ENV | SET | `production` |
| PROCESS_ROLE | SET | `api` |
| OUTBOX_PROCESSOR_ENABLED | SET | `false` on API (worker owns outbox) |
| INVENTORY_SYNC_ENABLED | SET | `false` fail-closed |
| CANARY_EMPLOYEE_ENABLED | SET | `false` |
| CANARY_ENVIRONMENT | SET | `staging` |
| CORS_ORIGINS | SET | `https://staging-widget.dialusnow.com` (+ temp Railway widget domain after smoke) |
| PUBLIC_API_URL | SET | `https://staging-api.dialusnow.com` |
| PUBLIC_WIDGET_URL | SET | `https://staging-widget.dialusnow.com` |
| JWT_EXPIRES_IN | SET | `15m` |
| JWT_REFRESH_EXPIRES_IN | SET | `7d` |
| WIDGET_TOKEN_EXPIRES_IN | SET | `4h` |
| CRM_WEBHOOK_URL | UNSET | Fail-closed; set when authorized CRM destination exists |
| ANTHROPIC_API_KEY | UNSET / OWNER | Required for live LLM; omit keeps non-LLM paths |
| TEKION_* | UNSET | Disabled until vendor access |
| VAUTO_* / inventory feed | UNSET | Inventory remains disabled |

## Worker variables

| Name | Status |
|------|--------|
| DATABASE_URL | SET (ref Postgres) |
| REDIS_URL | SET (ref Redis) |
| JWT_SECRET | SET (same material as API) |
| NODE_ENV | SET |
| PROCESS_ROLE | SET (`worker`) |
| OUTBOX_PROCESSOR_ENABLED | SET (`true`) |
| INVENTORY_SYNC_ENABLED | SET (`false`) |
| CANARY_EMPLOYEE_ENABLED | SET (`false`) |

## Widget

No secrets. Serves static `assistant-widget.iife.js`. Configure `PUBLIC` hosts via DNS only.

## Owner still required

- Authorize `ANTHROPIC_API_KEY` for staging LLM
- CRM webhook URL when ready
- Verified dealership origins for CORS expansion
- Squarespace DNS for custom domains (see `dialusnow-dns-records.md`)
