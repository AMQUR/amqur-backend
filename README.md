# AMQUR Backend

NestJS API for the AMQUR dealership AI assistant platform.

## Stack

- NestJS + TypeScript
- PostgreSQL + Prisma
- JWT auth (staff access + refresh tokens; short-lived widget tokens)
- Anthropic Claude (optional polish / educational Q&A)
- Cron-based inventory feed sync

## Non-negotiable product rule

**Never fabricate dealership-specific information.** Inventory, pricing, APR, hours, appointments, parts, and policies must come from verified tenant data or an authorized integration. When unverified, the assistant must say so and offer a next action (search, lead capture, human handoff).

## Local setup

```bash
cp .env.example .env
# fill DATABASE_URL and JWT_SECRET (>= 32 chars)

npm install
npx prisma migrate deploy
npx prisma generate
npm run start:dev
```

API base: `http://localhost:3000/api`  
Health: `GET /api/health` and `GET /api/health/live`

### Bootstrap first tenant (optional)

If `BOOTSTRAP_SECRET` is set:

```bash
curl -X POST http://localhost:3000/api/auth/bootstrap \
  -H 'Content-Type: application/json' \
  -d '{
    "secret":"YOUR_BOOTSTRAP_SECRET",
    "tenantName":"Demo Motors",
    "tenantSlug":"demo-motors",
    "email":"admin@example.com",
    "password":"ChangeMe123!",
    "firstName":"Admin",
    "lastName":"User"
  }'
```

Public self-registration is disabled. Staff users are created by `ADMIN` / `SUPER_ADMIN` via `POST /api/auth/register` or `POST /api/users`.

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run start:dev` | Watch mode |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run `dist/main.js` |
| `npm test` | Jest unit tests |
| `npm run lint` | ESLint |

## Auth model

| Actor | How |
|-------|-----|
| Staff | `POST /api/auth/login` → access + refresh tokens |
| Widget | `POST /api/public/widget-token` → 4h JWT with `role=widget` |
| Bootstrap | `POST /api/auth/bootstrap` with `BOOTSTRAP_SECRET` |

Global guards: JWT + Roles + Throttler. Tenant scope is taken from the JWT, never trusted from client body alone (except `SUPER_ADMIN` opt-in `?tenantId=`).

## Tenant isolation

- Vehicles unique on `(tenantId, vin)`
- Locations unique on `(tenantId, slug)`
- Users unique on `(tenantId, email)`
- Conversations / leads / appointments / escalations are tenant-scoped
- Conversation memory keys are `${tenantId}::${externalKey}` and persisted to Postgres

## Inventory

Configure `inventoryFeedUrl` + `inventoryFeedType` on a Location. Set `INVENTORY_SYNC_ENABLED=true` and optionally `INVENTORY_FEED_ALLOWED_HOSTS`. Feeds are validated against SSRF rules before fetch.

## Widget contract

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `GET /api/public/widget-config` | public | branding + feature flags |
| `POST /api/public/widget-token` | public | mint widget JWT |
| `POST /api/chat` | Bearer widget/staff JWT | chat turn (`message`, optional `conversationId`, `action`, `vin`) |

Response types the widget should handle: plain `{ reply }`, `vehicle_carousel`, `vehicle_compare`, `vehicle_detail`, `payment_summary`.

## Deployment (Railway / Docker)

```bash
docker build -t amqur-backend .
docker run --env-file .env -p 3000:3000 amqur-backend
```

Container runs `prisma migrate deploy` then `node dist/main.js`.

Railway: set env vars from `.env.example`, ensure `CORS_ORIGINS` lists dealership domains, and set `NODE_ENV=production`.

## Security checklist

- [ ] `JWT_SECRET` rotated and long
- [ ] `CORS_ORIGINS` set in production
- [ ] `BOOTSTRAP_SECRET` cleared after initial setup
- [ ] `INVENTORY_FEED_ALLOWED_HOSTS` set for production feeds
- [ ] CRM webhook URL uses HTTPS
- [ ] No `.env` committed

## External blockers

- Live Anthropic verification requires `ANTHROPIC_API_KEY`
- CRM delivery requires `CRM_WEBHOOK_URL`
- Google Calendar booking confirmation requires Google service-account credentials (appointment preference capture works without it)
- Production DB credentials and Railway project access
