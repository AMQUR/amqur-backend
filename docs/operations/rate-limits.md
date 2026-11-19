# Rate limiting — key strategy and 429 behavior

## Buckets

| Scope | Limit | TTL | Tracker key |
|---|---|---|---|
| default (all routes) | 120/min | 60 s | see "Key strategy" |
| `auth` named bucket | 20/min | 60 s | same tracker |
| `POST /public/widget-token` (route override) | 30/min | 60 s | same tracker |
| `GET /public/store-status` (route override) | 60/min | 60 s | same tracker |
| `POST /chat`, `POST /chat/stream` (route override) | 40/min | 60 s | same tracker |

Ceilings are raised under `NODE_ENV=test` for load labs (`src/common/rate-limits.ts`).
`RATE_LIMIT_PROFILE=production` makes a test stack use the production numbers; it can only
select the stricter set and does nothing outside `NODE_ENV=test`.

Known quirk (unchanged, stricter than the table): the `auth` named bucket is registered
globally, so it also counts every other route. The effective production ceiling of any route is
therefore `min(route limit, 20/min)` per tracker until that bucket is scoped to the auth routes.

## Key strategy

`TenantThrottlerGuard` (global `APP_GUARD`, registered after `JwtAuthGuard`) takes the tracker
from `resolveThrottleTracker` (`src/common/guards/throttle-tracker.ts`):

| Caller | Tracker | Why |
|---|---|---|
| widget token | `w:<tenantId>:<ip>` | tenant comes from the SIGNED token; per-dealership isolation behind a shared NAT |
| staff token | `u:<tenantId>:<userId>` | follows the user, not the network |
| public route (no token) | `ip:<ip>` | nothing else about the caller is verified |

Nothing the client can freely choose selects the bucket. In particular a `tenantSlug` in the
body or query is **never** part of the key: guards run before validation, so a rotated slug
(`?tenantSlug=r1`, `r2`, …) used to mint a fresh bucket per request and gave one IP unlimited
throughput (security review H1). The widget token's subject is not used either — widget tokens
are minted anonymously, so a per-token bucket could be reset by minting another token.

Trade-off: unauthenticated public endpoints (`widget-token`, `widget-config`, `store-status`)
are bucketed per IP only, so visitors of several dealerships behind one NAT share those (small)
public allowances. Chat itself is authenticated and stays isolated per dealership.

Behind Railway's proxy, the first `X-Forwarded-For` hop (`req.ips[0]`) is used, so the key
reflects the real client, not the edge.

Buckets are additionally scoped per route by the underlying throttler storage, and counters live
in process memory per instance (acceptable for the single-instance staging pilot; use a Redis
throttler storage before horizontal scaling).

## Concurrent chat streams

The per-minute throttle bounds how many turns a caller may start, not how many are in flight.
`POST /chat/stream` therefore also takes a concurrency slot (`src/chat/stream/stream-concurrency.ts`):

| Key | Default | Env |
|---|---|---|
| per client IP | 10 | `CHAT_STREAM_MAX_CONCURRENT_PER_IP` |
| per bearer token (SHA-256 digest, never the token) | 4 | `CHAT_STREAM_MAX_CONCURRENT_PER_TOKEN` |

Over the cap the caller gets a plain JSON **429** with `Retry-After: 5` before any stream starts.

**Disconnected streams are completed, not aborted.** A turn may carry an already-accepted lead
or appointment submission; aborting on disconnect could lose it or leave it half written. The
cost of "open, then drop" is bounded instead: the stream still counts against the throttle and
its slot is held until the *turn* finishes, so dropping the socket frees nothing. Counters are
per process (N replicas ⇒ N x the cap).

## 429 contract

When a bucket is exhausted the client receives:

- **HTTP 429 Too Many Requests**
- `Retry-After` header (seconds until the window resets)

Widgets should back off until `Retry-After` elapses and then retry once;
the widget bootstrap already retries token minting with a 400 ms delay and
surfaces a friendly failure rather than hammering the API.
