# Railway deployment

## Services

| Service | Image/start | Notes |
|---------|-------------|-------|
| `api` | Dockerfile → migrate + `node dist/main.js` | Public HTTPS; health `/api/health` |
| `worker` | `node dist/worker.js` | Outbox processor; no public port required |
| `postgres` | Railway Postgres | Primary datastore |
| `redis` | Railway Redis | Optional cache; API stays ready if down |

Widget CDN is **not** Railway Node — publish `dist/amqur-widget.iife.js` to object storage/CDN.

## Build

- Prefer Dockerfile (multi-stage) referenced by `backend/railway.json`
- `npx prisma migrate deploy` before start
- Fail start if `DATABASE_URL` / `JWT_SECRET` missing (Joi validation)

## Health

- Liveness: `GET /api/health/live`
- Readiness: `GET /api/health` — **requires DB up**; Redis down → `status=degraded` but still ready

## Graceful shutdown

Nest `enableShutdownHooks()`; worker clears poll interval on SIGTERM.
