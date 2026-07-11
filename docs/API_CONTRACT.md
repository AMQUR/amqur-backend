# API Contract — Widget ↔ Backend

Canonical Nest envelope: `{ success: true, data: T }` (or error shape from `GlobalExceptionFilter`).

## Public bootstrap

| Method | Path | Auth | Request | Response |
|--------|------|------|---------|----------|
| GET | `/api/public/widget-config` | none | `?tenantSlug=&locationSlug=` | `{ tenant, location, branding, features }` |
| POST | `/api/public/widget-token` | none | `{ tenantSlug, locationSlug }` | `{ token, expiresIn }` — Origin **required**; empty `allowedOrigins` fails closed |
| GET | `/api/health/live` | none | — | `{ ok: true }` |

## Chat

| Method | Path | Auth | Request | Response |
|--------|------|------|---------|----------|
| POST | `/api/chat` | Bearer widget/staff JWT | `{ message, conversationId?, action?, vin? }` | See response types below |

### Actions
- `hold_vehicle` + `vin`
- `payment_estimate` + `vin`
- `vehicle_detail` + `vin`

### Response types (`data`)
- `{ reply, provenance? }`
- `{ type: 'vehicle_carousel', vehicles[], reply, provenance? }`
- `{ type: 'vehicle_compare', vehicles[], reply, provenance? }`
- `{ type: 'vehicle_detail', vehicle, reply, provenance? }`
- `{ type: 'payment_summary', reply, monthlyPayment, termMonths, apr, downPayment, vehicleVin?, price?, provenance? }`

### Provenance
```ts
{
  sources: string[];           // e.g. ['inventory_db']
  inventoryAsOf?: string|null; // ISO
  disclaimer?: string;
  verifiedFactsOnly: boolean;
}
```

### Vehicle fields (inventory)
Includes `lastSeenAt`, `source` for freshness.

## Staff (JWT + roles)

| Path | Roles |
|------|-------|
| GET `/api/leads` | STAFF+ |
| GET `/api/escalations` | STAFF+ |
| GET `/api/metrics` | ADMIN+ |
| POST `/api/inventory-feed/parse` | MANAGER+ (staff only) |

## Deployment order
1. Deploy backend + `prisma migrate deploy`
2. Verify `/api/health`
3. Deploy widget IIFE
4. Set `CORS_ORIGINS` and optional tenant `allowedOrigins`

## Phase 2 additions
- Bootstrap `features` expanded (compare, savedVehicles, serviceAi, partsAi, multilingual, proactiveEngagement, …)
- `GET /api/integrations/health` (staff)
- `GET|POST|DELETE /api/saved-vehicles` (widget JWT)
- `GET /api/copilot/conversations/:id` (staff)
- Inventory vehicles may include `freshnessState` and `source`
