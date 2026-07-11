# vAuto inventory feed

## Status
Treats vAuto as an **authorized feed provider** (HTTPS/XML/JSON/CSV), not an invented REST API.

## Pipeline
Download → checksum → validate → stage → reconcile → freshness → metrics

## Safety
- Empty or anomalous snapshots are **REJECTED** (`REJECTED_ANOMALY`)
- Last-known-good inventory is preserved
- Min record threshold + size-drop anomaly checks

## Configuration
- `Location.inventoryFeedUrl` + `inventoryFeedType`
- `Location.inventoryMinRecords`
- `INVENTORY_SYNC_ENABLED=true`
- `INVENTORY_FEED_ALLOWED_HOSTS`

## Import runs
Persisted in `InventoryImportRun` with status, checksum, anomalies.
