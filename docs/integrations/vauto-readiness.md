# vAuto readiness

**Status:** Intended inventory provider via **authorized feed download** (HTTPS URL on `Location.inventoryFeedUrl`). No invented public REST API.

## What exists in code

- `VAutoFeedProvider` + inventory ingestion pipeline
- Location fields: `inventoryFeedUrl`, `inventoryFeedType` (XML|JSON|CSV)
- SSRF-safe feed fetch (`assertFeedUrlAllowed` + optional host allowlist)
- Import runs, freshness states (`FRESH|DEGRADED|STALE|UNAVAILABLE`), anomaly guards
- Feature flag `vAutoFeed` (fail-closed by default)

## What we will NOT invent

- Undocumented vAuto “public API” endpoints
- Fabricated inventory counts, VINs, or prices

## Required before pilot inventory is enabled

1. Authorized feed URL + format confirmation per rooftop
2. Expected minimum record counts / freshness SLA hours
3. Host allowlist entry in `INVENTORY_FEED_ALLOWED_HOSTS`
4. Staging dry-run import with checksum + anomaly review
5. Explicit enable of tenant `featureFlags.inventory=true` only when fresh vehicles exist

## Operational notes

- Capability gating refuses inventory answers when no fresh vehicles exist
- Cron sync: `INVENTORY_SYNC_ENABLED=true` (prefer single worker replica)
