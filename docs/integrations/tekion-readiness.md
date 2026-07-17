# Tekion readiness

**Status:** Adapter shell only — **disabled** until partner credentials + official API documentation are provided.

## What exists in code

- `IntegrationProvider.TEKION` + `IntegrationConnection` with `enabled` / `liveReady`
- `TekionProvider` implementing CRM/DMS-shaped methods that **refuse live calls** when not `liveReady`
- Feature flag `tekionIntegration` hard-gated on a liveReady connection
- Encrypted `IntegrationSecret` vault (AES-GCM) ready to store credentials once authorized
- Outbox topic hooks for CRM writeback retries

## What we will NOT invent

- Base URLs, OAuth paths, webhook signatures, dealer mapping IDs, or request/response schemas
- Claims of live Tekion sync, RO status, or confirmed appointments

## Required from Tekion / dealer IT before enablement

1. Official API docs (auth, environments sandbox/prod, rate limits)
2. Client ID/secret or partner credentials for **sandbox** first
3. Dealer/group IDs for each rooftop tenant
4. Allowed webhook signing secret + inbound IP allowlist if applicable
5. Data processing agreement + retention alignment
6. Explicit written approval to set `liveReady=true` per tenant

## Enablement checklist (after docs)

1. Store secrets via vault (never env plaintext in app logs)
2. Create `IntegrationConnection` `provider=TEKION`, `enabled=true`, `liveReady=false`
3. Health probe against sandbox; circuit breaker wired
4. Idempotent writeback tests with disposable sandbox leads
5. Flip `liveReady=true` only after signed UAT sign-off
