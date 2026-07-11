# Migration review — staging pilot

## Additive migrations to apply on STAGING only

| Migration | Purpose | Destructive? |
|---|---|---|
| `20260123154732_add_inventory_feed_to_location` | Feed URL on location | No |
| `20260123161422_add_last_seen_at_to_vehicle` | lastSeenAt | No |
| `20260125200108_add_vehicle_missing_status` | MISSING status | No |
| `20260711180000_production_hardening` | Auth/tenant hardening models | No |
| `20260711200000_tekion_vauto_ai_expansion` | Integrations, flags, freshness, outbox | No |

## Deploy command (staging DATABASE_URL only)

```bash
cd backend
export DATABASE_URL="<STAGING_DATABASE_URL>"
npx prisma migrate deploy
npx prisma validate
npx prisma generate
```

## Forbidden

- `prisma migrate reset`
- `prisma db push --force-reset`
- Running migrate against production without explicit approval
- Down-migrations
