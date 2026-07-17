# Rate limiting — key strategy and 429 behavior

## Buckets

| Scope | Limit | TTL | Tracker key |
|---|---|---|---|
| default (all routes) | 120/min | 60 s | `tenantSlug:ip` when the request carries a tenant slug, else `ip` |
| `auth` named bucket | 20/min | 60 s | same tracker |
| `POST /public/widget-token` (route override) | 30/min | 60 s | same tracker |

(Ceilings are raised automatically under `NODE_ENV=test` for load labs.)

## Key strategy

`TenantThrottlerGuard` (global `APP_GUARD`) extends the Nest ThrottlerGuard
tracker:

- Public widget endpoints carry `tenantSlug` in the body (`widget-token`) or
  query (`widget-config`). The bucket key is **`${tenantSlug}:${ip}`** —
  per-dealership isolation even when many dealerships' visitors sit behind
  one corporate proxy / NAT IP.
- Requests without a tenant slug fall back to per-IP buckets.
- Non-string slugs are ignored (no bucket forgery via crafted JSON).
- Behind Railway's proxy, the first `X-Forwarded-For` hop (`req.ips[0]`) is
  used, so the key reflects the real client, not the edge.

Buckets are additionally scoped per route by the underlying throttler
storage, and counters live in process memory per instance (acceptable for
the single-instance staging pilot; use a Redis throttler storage before
horizontal scaling).

## What one tenant under load looks like

A burst against `jeep-of-chicago` fills `jeep-of-chicago:<ip>` buckets only.
`dial-nissan-of-chicago` visitors — even from the same IP — keep their own
allowance. This was validated by the tenant-throttler unit spec
(`tenant-throttler.guard.spec.ts`) and the staging load profiles
(`scripts/load-profiles.mjs`).

## 429 contract

When a bucket is exhausted the client receives:

- **HTTP 429 Too Many Requests**
- `Retry-After` header (seconds until the window resets)

Widgets should back off until `Retry-After` elapses and then retry once;
the widget bootstrap already retries token minting with a 400 ms delay and
surfaces a friendly failure rather than hammering the API.
