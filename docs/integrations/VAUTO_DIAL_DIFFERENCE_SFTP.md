# Dial Difference vAuto inventory — SFTPGo → AMQUR

**Status:** `IMPLEMENTED NOT CONNECTED`  
**Date:** 2026-11-20  

AMQUR extends the existing vAuto HTTPS feed provider with a **read-only** SFTP transport for the dedicated Dial Difference inventory server. This is **not** the Google VLA / `sftp.dialautogroup.com` pipeline. Do not modify upload accounts, VLA automation, or the Dial Difference website reader.

## Endpoint (owner-provisioned)

| Property | Value |
|---|---|
| Host | `sftp.dialdifference.com` → `107.170.127.209` |
| Port | `2022` |
| Server | SFTPGo 2.7.6 |
| AMQUR user | `amqur_inventory_reader` (list + download only) |
| Virtual root | `/` with ten dealership folders |

### Host fingerprint (independently verified 2026-11-20)

```text
ssh-keyscan -p 2022 -t ed25519 sftp.dialdifference.com
→ SHA256:RB74t0jOln5yBXsa35xeTZgIfpynQSiTKnn0xzHK11Y
```

(OpenSSH may omit base64 padding `=`; the connector normalizes both forms.)

RSA/ECDSA host keys also exist on the server; pin **ed25519** as configured above. A mismatch **refuses** the connection.

## Ten sources

| Directory | AMQUR tenant slug | Condition |
|---|---|---|
| `/chevy/new`, `/chevy/used` | `dial-chevy-of-chicago` | new / used |
| `/nissan/new`, `/nissan/used` | `dial-nissan-of-chicago` | new / used |
| `/infiniti/new`, `/infiniti/used` | `infiniti-of-chicago` | new / used |
| `/cdjr_south/new`, `/cdjr_south/used` | `dial-cdjr-of-chicago` | new / used |
| `/jeep_north/new`, `/jeep_north/used` | `jeep-of-chicago` | new / used |

North (`jeep_north`) and South (`cdjr_south`) never share a tenant mapping.

Code: `src/integrations/vauto/dial-difference-feed-map.ts`.

## Environment (server-side secrets only)

```env
AMQUR_VAUTO_SFTP_ENABLED=false
AMQUR_VAUTO_SFTP_HOST=sftp.dialdifference.com
AMQUR_VAUTO_SFTP_PORT=2022
AMQUR_VAUTO_SFTP_USER=amqur_inventory_reader
AMQUR_VAUTO_SFTP_PASSWORD=<SECRET_STORE_ONLY>
AMQUR_VAUTO_SFTP_HOST_FINGERPRINT=SHA256:RB74t0jOln5yBXsa35xeTZgIfpynQSiTKnn0xzHK11Y
AMQUR_VAUTO_PUBLISH_PRICES=false
AMQUR_VAUTO_PUBLISH_PHOTOS=false
INVENTORY_SYNC_ENABLED=false
```

Until `AMQUR_VAUTO_SFTP_PASSWORD` is present in the authorized secret store and `AMQUR_VAUTO_SFTP_ENABLED=true` on staging, live ingest stays off. Fixtures under `fixtures/vauto/dial-difference-sftp/` exercise the pipeline without credentials.

Customer-facing **prices** and **photos** stay suppressed until dealership approval (`AMQUR_VAUTO_PUBLISH_*`).

## Lifecycle rules (critical)

Absence from a feed is **not** a sale.

| State | Meaning |
|---|---|
| `AVAILABLE` | Present in the latest successful snapshot for that `feedSourceKey` |
| `MISSING` | Not refreshed in the latest successful snapshot for that source |
| `REMOVED_FROM_LISTING` | Missing longer than the retention window — still not sold |
| `QUARANTINED` | Failed validation |
| `SOLD` | Only with explicit vendor/staff evidence (`markExplicitlySold`) |

New and Used are reconciled **separately** via `feedSourceKey`. A New-only delivery cannot remove Used stock. Empty or anomalous snapshots reject (`REJECTED_ANOMALY`) and preserve last-known-good.

## Scheduler

`InventorySyncService` (every 30m when `INVENTORY_SYNC_ENABLED=true`) runs HTTPS location feeds, then Dial Difference SFTP when `AMQUR_VAUTO_SFTP_ENABLED=true`. Concurrent SFTP runs are skipped.

## Out of scope / protected

- Google VLA / Merchant Center / `sftp.dialautogroup.com` / `feeds.dialautogroup.com`
- vAuto upload accounts (`vauto_dd_*`)
- `dialdifference_inventory_reader` (website)
- Production customer-facing live inventory until real files pass acceptance

## Activation checklist (staging → production)

1. Store `AMQUR_VAUTO_SFTP_PASSWORD` in Railway/secret vault (never Git).
2. Confirm fingerprint still matches `ssh-keyscan`.
3. Enable on **isolated staging** only; keep publish flags false.
4. Wait for real vAuto files in all ten directories.
5. Verify formats, VIN/stock maps, New/Used counts, VDP hosts, North≠South.
6. Approve price field + image rights before `PUBLISH_*`.
7. Owner gate for production.
