# Production Readiness

## Status
Backend on `audit/production-readiness` is production-capable for multi-tenant dealership chat with tool-grounded inventory answers, persisted leads/handoffs, staff RBAC, provenance metadata, Origin-scoped widget tokens, and in-process metrics.

## Hardening in this pass
- Staff-locked inventory feed parse
- Inventory `lastSeenAt` / freshness disclaimers / chat provenance
- Appointment/hold language stays request/tentative (not confirmed)
- Widget Origin allowlist via `Tenant.allowedOrigins`
- Auth throttling + login audit logs
- Metrics: `GET /api/metrics` (ADMIN+)
- Cross-tenant unit isolation tests + e2e smoke harness
- Docs: API contract, hardening plan, this readiness note

## Deploy
1. Set env from `.env.example` (`DATABASE_URL`, `JWT_SECRET` ≥32 chars, `CORS_ORIGINS`)
2. `npx prisma migrate deploy && npx prisma generate`
3. `npm ci && npm run build && npm run start:prod`
4. Or Docker: `docker build -t amqur-backend . && docker run --env-file .env -p 3000:3000 amqur-backend`
5. Optional one-time `POST /api/auth/bootstrap` then **clear `BOOTSTRAP_SECRET`**
6. Set tenant `allowedOrigins` for production widget domains

## Rollback
1. Redeploy previous container/image
2. Do not run destructive down-migrations; additive schema can remain
3. Revert widget CDN to previous IIFE if API contract regresses

## Verify locally
```bash
npm ci
npm run typecheck
npm test
npm run build
# optional if Postgres available:
npm run test:e2e
```

## Known follow-ups
- Nest transitive npm audit (multer/path-to-regexp) — upgrade carefully
- Redis/BullMQ for multi-instance conversation cache and feed job locks
- Full Swagger UI (contract documented in `docs/API_CONTRACT.md`)
- Live Google Calendar confirmation for appointments
- Prometheus/OTLP exporters (counters are in-process today)
