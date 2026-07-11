# Production Hardening Plan (Phase A)

**Branch:** `audit/production-readiness`  
**Date:** 2026-07-11

## Prior hardening already landed
- Auth lockdown, RolesGuard, ThrottlerGuard, refresh tokens, bootstrap secret
- Tenant-scoped VIN/location/email uniqueness
- Conversation/lead/escalation persistence
- Human handoff, SSRF feed guards on sync
- Payment/appointment safety language (primary paths)

## Remaining work (this pass)

### P0
1. Lock `POST /inventory-feed/parse` to staff roles
2. Cross-tenant HTTP denial tests
3. Appointment/hold copy safety on remaining paths
4. Return `lastSeenAt` + freshness disclaimer + provenance on chat responses
5. Auth endpoint throttle naming
6. Fix e2e smoke + `test:e2e` script

### P1
7. Enrich leads list for staff
8. Minimal Swagger/OpenAPI
9. Widget-token Origin allowlist when `Tenant.allowedOrigins` set
10. Audit log on login
11. Production docs + API contract doc
12. Observability metrics hooks (lightweight in-process counters)

### Widget (coordinated)
1. Contract fixtures + CI test gate
2. Feature flag gating for inventory/payments
3. destroy() clears connection state + version
4. Retry on failed messages
5. Remove dead useChat/chatAdapter
6. Deployment/rollback docs

## Non-goals this pass
- Mass Prettier rewrite
- Redis/BullMQ introduction
- Full Next.js admin UI
- Vector/RAG rewrite
