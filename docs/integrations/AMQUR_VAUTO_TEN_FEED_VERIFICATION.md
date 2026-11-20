# AMQUR — vAuto ten-feed verification

**Verification time (UTC):** 2026-11-20T18:47:10.522Z  
**Source environment:** Railway `amqur-platform-staging` / `staging` / `worker-staging`  
**Worker deployment ID:** `925dcfec-c3d1-4210-9096-6b6655430e42` (SUCCESS)  
**Worker release.json SHA (image stamp):** `b90d6eea7bcd62741679e48bb27b2fc7aa6f2d39`  
**Backend staging `/api/version` SHA:** `44d843bbb34d2acd7f336ee5c49349d9fb3da465`  
**Diagnostic:** `scripts/diagnose-vauto-sftp-readonly.mjs` v1.1.0-20261120  
**Evidence artifact:** `amqur-backend/docs/evidence/vauto-sftp-20261120/worker-readonly-verify-20261120T184710Z.json`

## Verdict

# CONNECTED — WAITING FOR VAUTO FILES

Authenticated read-only SFTP from the **actual** Railway staging worker succeeded. All ten allowlisted directories exist and list successfully. **Zero inventory export files** were present at verification time. No import or publish was performed.

## Runtime confirmation

| Check | Result |
|---|---|
| Project | `amqur-platform-staging` (`e4d54510-bbc0-45bc-9d5b-a19a5ad5132c`) |
| Environment | `staging` |
| Service | `worker-staging` (`PROCESS_ROLE=worker`) |
| Execution locus | `railway ssh` into live worker (`/app`) — not local `railway run` |
| Password present | yes (value not logged) |
| Host | `sftp.dialdifference.com` |
| Port | `2022` |
| User | `amqur_inventory_reader` |

## Host-key verification

| Source | Fingerprint |
|---|---|
| Independent `ssh-keyscan -p 2022 -t ed25519` (agent, 2026-11-20) | `SHA256:RB74t0jOln5yBXsa35xeTZgIfpynQSiTKnn0xzHK11Y` |
| Runbook pin | same |
| Worker configured pin prefix | `SHA256:RB74t0jOln5yB` |
| Live verifier outcome | **MATCH** |

No insecure host-key bypass was used.

## Authentication

**SUCCEEDED** as `amqur_inventory_reader` with pinned ED25519 host key.

## Safety flags (must remain false)

| Flag | Observed on worker |
|---|---|
| `AMQUR_VAUTO_SFTP_ENABLED` | `false` |
| `INVENTORY_SYNC_ENABLED` | `false` |
| `AMQUR_VAUTO_PUBLISH_PRICES` | `false` |
| `AMQUR_VAUTO_PUBLISH_PHOTOS` | `false` |

Diagnostic used an independent read-only path and did not enable ingest/publish.

## Read-only / isolation assessment

- Operations: connect, list allowlisted dirs, disconnect. No uploads/deletes/renames.
- Write restriction: **not proven** by this diagnostic (no write attempted). Relies on SFTPGo account config + path allowlist.
- Path allowlist: only the ten Dial Difference feed directories from `dial-difference-feed-map.ts`.

## Ten-feed matrix

| Store | Feed | Directory | Listing | File Count | Latest Filename | Size | Modified UTC | Format | Validation | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| Dial Chevy of Chicago | New | `/chevy/new` | OK | 0 | — | — | — | — | N/A_EMPTY | EMPTY |
| Dial Chevy of Chicago | Used | `/chevy/used` | OK | 0 | — | — | — | — | N/A_EMPTY | EMPTY |
| Dial Nissan of Chicago | New | `/nissan/new` | OK | 0 | — | — | — | — | N/A_EMPTY | EMPTY |
| Dial Nissan of Chicago | Used | `/nissan/used` | OK | 0 | — | — | — | — | N/A_EMPTY | EMPTY |
| INFINITI of Chicago | New | `/infiniti/new` | OK | 0 | — | — | — | — | N/A_EMPTY | EMPTY |
| INFINITI of Chicago | Used | `/infiniti/used` | OK | 0 | — | — | — | — | N/A_EMPTY | EMPTY |
| Dial CDJR South | New | `/cdjr_south/new` | OK | 0 | — | — | — | — | N/A_EMPTY | EMPTY |
| Dial CDJR South | Used | `/cdjr_south/used` | OK | 0 | — | — | — | — | N/A_EMPTY | EMPTY |
| Jeep of Chicago North | New | `/jeep_north/new` | OK | 0 | — | — | — | — | N/A_EMPTY | EMPTY |
| Jeep of Chicago North | Used | `/jeep_north/used` | OK | 0 | — | — | — | — | N/A_EMPTY | EMPTY |

## File inspection

Not applicable — no candidate files present. Format validation and import remain **NOT TESTED** on live exports.

## Distinct milestones

| Milestone | Status |
|---|---|
| File successfully received | NO (all EMPTY) |
| File format valid | N/A |
| File contents valid | N/A |
| Staging validator accepted | N/A |
| File ingested into AMQUR | NO (sync flags false; no files) |

## Unresolved issues / next action

1. **vAuto / Dial Difference feed ops** must deliver New+Used exports into all ten folders.
2. After files arrive: re-run `AMQUR_SFTP_DIAGNOSTIC=1 node scripts/diagnose-vauto-sftp-readonly.mjs` on `worker-staging`.
3. Only then consider staging-only `AMQUR_VAUTO_SFTP_ENABLED=true` with publish flags still false.
4. Sync `worker-staging` image SHA to match backend `44d843b` (or newer) when deploying the baked-in diagnostic script.

**Accountable provider for empty folders:** vAuto / Dial Difference inventory feed operations (owner F3).
