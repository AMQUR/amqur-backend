# Production deployment — AMQUR backend

## Official projects

| Environment | Railway project | Notes |
|---|---|---|
| Staging | `amqur-platform-staging` | Authorized for employee/staging tests |
| Production | **TBD — create `amqur-platform-production`** | Must be clearly labeled; AMQUR-owned |

## Do not use

| Project | Why |
|---|---|
| `divine-integrity` | Unlabeled; linked to personal fork `saadimranhere/amqur-backend`, not `AMQUR/amqur-backend` |
| `distinguished-laughter` | Empty / unrelated |
| Staging hosts as final public production | Staging may be used only for labeled employee tests |

## Required production services (when authorized)

- `backend-production`
- `postgres-production`
- `redis-production`
- `widget-production` (or CDN) with version-pinned IIFE + canary loader

## Required production env (names only — set in Railway UI)

`NODE_ENV`, `DATABASE_URL`, Redis URL, `JWT_SECRET`, refresh secrets, `CANARY_*`, `CANARY_STRICT_ORIGINS`, `CORS_ORIGINS`, `INTEGRATION_ENCRYPTION_KEY`, `CRM_WEBHOOK_URL` (when approved), feature flags keeping Tekion/vAuto/inventory/messaging/voice off.

Never commit `.env` production files. Never paste secrets into chat or Git.

## Migrations

Use `prisma migrate deploy` only against verified production DB (hostname redacted in logs).  
Never `migrate reset`, destructive `db push`, or unscoped DELETE/TRUNCATE/DROP.
