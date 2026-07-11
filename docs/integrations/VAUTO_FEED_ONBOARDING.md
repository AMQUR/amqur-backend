# vAuto feed onboarding — Dial Auto Group

**Status:** BLOCKED for live feed — no authorized SFTP/HTTPS feed URL or credentials found in Railway, Keychain, or env stores.  
**Staging inventory:** fixture XML only (`fixtures/vauto/staging-inventory.fixture.xml`).  
**Flag:** `vAutoFeed=false` on staging seed unless `STAGING_VAUTO_FEED_URL` is set.

Do not invent a vAuto REST API. Do not scrape vAuto.

---

## Required (store out of Git)

| Item | Present? |
|---|---|
| Authorized feed transport (HTTPS / SFTP / FTPS) | NO |
| Feed URL or host + path | NO |
| Auth (token / cert / password) | NO |
| Format (XML / CSV / JSON) | NO |
| Per-rooftop location keys in feed | NO |
| Expected min records / freshness SLA | NO |
| Provider count report for reconciliation | NO |

Config surfaces when available:
- `Location.inventoryFeedUrl` + `inventoryFeedType`
- `Location.inventoryMinRecords` / `inventoryFreshnessHours`
- `INVENTORY_SYNC_ENABLED=true` (staging first)
- `INVENTORY_FEED_ALLOWED_HOSTS=<feed host>`
- Optional env: `VAUTO_FEED_TRANSPORT`, `VAUTO_EXPECTED_MIN_RECORDS`, `VAUTO_FRESHNESS_HOURS`

---

## Staging activation sequence

1. Place feed URL on staging location only.
2. Allowlist feed hostname.
3. Enable sync on staging backend.
4. Inspect schema → versioned mapping.
5. Validate VINs, location map, counts, prices, images, timestamps.
6. Stage snapshot → anomaly checks → preserve LKG on reject.
7. Repeated imports across multiple snapshots before any production enablement.
8. Verify search, provenance, freshness, no internal market data to customers.
9. Cross-store inventory remains **off** unless explicitly approved.

## Safety already in code

Empty/anomalous snapshots → `REJECTED_ANOMALY`; last-known-good preserved (`docs/integrations/vauto.md`).
