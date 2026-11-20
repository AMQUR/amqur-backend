# Railway ownership reconciliation — 2026-11-20

## Authenticated context

| Field | Value |
|---|---|
| CLI identity | `admin@amqur.com` |
| Workspace | `amqur's Projects` (AMQUR company) |
| Personal workspace | Not used as default after migration |

## Projects (transferred, not rebuilt)

| Project | ID | Notes |
|---|---|---|
| `amqur-platform-staging` | `e4d54510-bbc0-45bc-9d5b-a19a5ad5132c` | Isolated staging home |
| `dial-us-now-platform` | (present in workspace list) | Preserve PR #33 shared staging |

## `amqur-platform-staging` environments

| Environment | ID | Role |
|---|---|---|
| `staging` (linked) | `b58a4e5f-e8ad-4620-bc41-4874887c788e` | Engineering verification |
| `production` | present | Do not activate customer features from this mission |

## Staging services (verified Online)

| Service | Status | Notes |
|---|---|---|
| `backend-staging` | Online | `https://backend-staging-staging-b699.up.railway.app` |
| `worker-staging` | Online | `PROCESS_ROLE=worker`; SFTP password SET; flags false |
| `widget-staging` | Online | `https://widget-staging-staging.up.railway.app` |
| Postgres | Online · `postgres-volume` | Intact |
| Redis | Online · `redis-volume` | Intact |

## Variable presence (names only; values not logged)

Worker-staging: `AMQUR_VAUTO_SFTP_*` present; four activation flags `false`; `DATABASE_URL`/`REDIS_URL` SET; `DEPLOYMENT_TIER=staging`.

## CI/CD note

GitHub Actions `RAILWAY_API_TOKEN` must be a token scoped to the **AMQUR company** workspace after migration. If deploy jobs fail with unauthorized/forbidden, owner rotates the Actions secret to a company-scoped token (never paste into chat/Git).

## Do not

- Recreate projects, reset Postgres/Redis, or delete volumes.
- Target the old personal workspace by default.
