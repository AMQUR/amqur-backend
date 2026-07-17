# AMQUR Platform — Production Readiness Audit (Phase 1)

**Date:** 2026-07-16  
**Auditor role:** Principal architect / security / reliability / QA / DevOps  
**Repos:** `backend/` → `production-readiness/pilot-prep`; `amqur-widget/` → `production-readiness/pilot-prep`  
**Workspace:** `/Users/saad/Downloads/amqur-platform` (local container for two independent git repos)

---

## 1. Repository status (baseline)

| Item | Value |
|------|--------|
| Workspace git | Incomplete parent `.git` with no commits — **do not use for product history** |
| Backend remote | Nested repo; branch created `production-readiness/pilot-prep` from `main` |
| Widget remote | Nested repo; branch created `production-readiness/pilot-prep` from `main` |
| Prior hardening | `audit/production-readiness` exists on both remotes with substantial work already merged toward main |

### Non-negotiable product rule (confirmed in README)

Never fabricate dealership-specific inventory, pricing, APR, hours, appointments, parts, or policies. Unverified → say unavailable + offer staff handoff.

---

## 2. Module / surface inventory

### Backend Nest modules (`backend/src/`)

| Module | Purpose |
|--------|---------|
| Auth | Staff JWT + refresh; bootstrap; widget role |
| Tenants / Locations / Users | Tenant CRUD, locations, staff users |
| Public | Widget config/token; canary employee auth |
| Chat | Orchestrator, inventory/payment engines, Claude polish |
| Inventory / InventoryFeed / InventorySync | Vehicle upsert, feed parse, 30m cron |
| Integrations | Tekion/vAuto shells, vault, outbox, circuit breaker, webhooks |
| FeatureFlags / SourceAuthority | Flag merge; field-level truth rules |
| Leads / Escalations / SavedVehicles / Parts / FollowUp / Copilot | CRM-facing ops |
| Health / Observability / AI | Readiness, in-process metrics, Anthropic |

### HTTP surface (global prefix `/api`)

Public: `health`, `health/live`, `public/widget-config`, `public/widget-token`, canary redeem/eligibility, auth login/refresh/logout/bootstrap.  
Staff: tenants, locations, users, leads, escalations (+ ack/claim/resolve/notes), inventory-feed/parse, integrations/health, metrics, copilot, saved-vehicles.  
Widget/staff: `POST /chat`.

### Prisma models (pre-Phase-2)

Tenant, Location, User, Vehicle, Conversation, Message, Lead, Appointment, Escalation, RefreshToken, AuditLog, IntegrationConnection/Secret, SourceAuthorityRule/Conflict, InventoryImportRun, SavedVehicle, PartsInquiry, OutboxEvent, WebhookInbox, FollowUpCampaign, CanaryInvite.

**Missing at audit time:** `DealerGroup`, tenant/location public branding config, group memberships.

### Widget

IIFE embed (`embed.tsx` → Shadow DOM), `connect.ts` bootstrap/JWT, ChatView + vehicle UI, staging host, canary loader package, Vitest + optional Playwright staging.

### Integrations present

| Provider | Status |
|----------|--------|
| Inventory feed (vAuto-oriented) | HTTPS feed download + parse; no invented public API |
| Tekion | Disabled adapter until `liveReady` + credentials |
| Generic CRM webhook | Optional `CRM_WEBHOOK_URL` |
| Google Calendar | Optional; appointments stay REQUESTED without verification |
| Twilio / messaging / voice | Ports/stubs; voice forced off in widget flags |

---

## 3. Defects & gaps identified

### Critical

| ID | Finding | Evidence |
|----|---------|----------|
| C1 | No `DealerGroup` / group RBAC | Schema has only Tenant |
| C2 | Chat path does not enforce feature/capability flags | No `FeatureFlagsService` in chat |
| C3 | Canary loader ignores Nest `{ data }` envelope → eligibility always false | Widget canary loader |

### High

| ID | Finding |
|----|---------|
| H1 | Optimistic feature defaults (`inventory`/`payments`/etc. default `true`) |
| H2 | Hardcoded widget branding in `public.service.ts` |
| H3 | No Redis/worker split; cron + circuit state single-process |
| H4 | Outbox enqueue without processor → events stall |
| H5 | Secret vault implemented but unused for live credential I/O |
| H6 | Widget bootstrap drops `proactive` / `locales` |
| H7 | Empty `cdn/amqur-widget.js` stub risk if published |

### Medium

| ID | Finding |
|----|---------|
| M1 | Circuit breaker unused by providers |
| M2 | Bootstrap secret in JSON body; endpoint open while env set |
| M3 | Soft-fail CRM/Claude catches can over-claim handoff success |
| M4 | Railway Nixpacks start omits `prisma migrate deploy` (Docker includes it) |
| M5 | E2E not in CI; skips without DB |
| M6 | `users.findByEmail` unscoped variant |

### Low

Orphan `AppController`; in-process metrics only; docs version drift; Jeep-specific test fixtures (acceptable for pilot).

### Secrets hygiene

`.env.local` / `.env.production` exist on disk, **gitignored and untracked**. Templates (`.env.example`) are tracked. CI secret-scan present.

---

## 4. Risk register (baseline → remediation ownership)

| Severity | Count | Primary remediation phase |
|----------|-------|---------------------------|
| Critical | 3 | Phases 2–3, 7, widget fix |
| High | 7 | Phases 2–6 |
| Medium | 6 | Phases 4, 7, 9 |
| Low | 4 | Phase 8–11 docs/cleanup |

---

## 5. External blockers (unchanged by code alone)

1. Authorized Tekion partner credentials + official API docs (do not invent endpoints).
2. Authorized vAuto / inventory feed URL + format confirmation per rooftop.
3. CRM webhook destination (or Tekion writeback) for durable handoff delivery.
4. Railway project, Postgres, Redis, domains, CDN for widget IIFE.
5. Team Velocity / website vendor CSP + embed approval.
6. Legal/display names + domains for any fifth Dial rooftop (do not invent).
7. Production Anthropic key if Claude polish enabled.
8. Employee canary GTM publish access (historically blocked).

---

## 6. Target tenancy model (implementation target)

- One shared platform; **one tenant per dealership rooftop**.
- `DealerGroup` associates isolated tenants for **authorized group reporting only**.
- Example: Dial Auto Group → Jeep of Chicago, Dial Nissan, Dial Chevy, Dial CDJR of Chicago (each `main` location). No fifth rooftop until verified.
- Group access requires explicit membership + role; normal tenant admin never gets cross-tenant access.

---

## 7. Audit conclusion

The platform is a **credible multi-tenant chat core** with JWT RBAC, Origin-scoped widget tokens, inventory freshness/provenance, canary auth scaffolding, Docker healthchecks, and CI secret/migration scans.

It was **not pilot-complete** at audit start due to missing dealer-group model, hardcoded branding, optimistic/ungated capabilities, stalled outbox, and multi-instance reliability gaps.

**This audit continues into implementation** (Phases 2–11) on `production-readiness/pilot-prep` without stopping at documentation.

---

## 8. Verification commands (baseline)

```bash
# Backend
cd /Users/saad/Downloads/amqur-platform/backend
npm ci && npm run typecheck && npm test && npm run build

# Widget
cd /Users/saad/Downloads/amqur-platform/amqur-widget
npm ci && npm run lint && npm test && npm run build
```

Results will be recorded in `docs/final-production-readiness-report.md` after remediation.
