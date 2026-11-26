# AMQUR — production installation (engineering prep)

**Status:** Staging-oriented runbook. **No production customer activation** is authorized by this document.

## Repositories / branches (2026-11-20)

| Repo | Branch | SHA | PR | Activation |
|---|---|---|---|---|
| `AMQUR/amqur-backend` | `integration/amqur-unified-sandbox` | `44d843b…` | #55 draft | Staging API online |
| `AMQUR/amqur-widget` | `feat/amqur-unified-sales-desk` | `7f2de57…` | #29 draft | Staging widget online |
| `AMQUR/dial-auto-group-platform` | `feat/amqur-embed-switch` | `631c9da…` | #13 draft | Embed gated off |

## Environments

| Name | Project | Purpose |
|---|---|---|
| Isolated staging | `amqur-platform-staging` / `staging` | Authorized engineering verification |
| Shared Dial Us Now staging | `dial-us-now-platform` | Preserve PR #33 candidate — do not overwrite casually |
| Production | separate | Requires capability-specific gates |

## Feature flags (keep false until acceptance)

```
AMQUR_VAUTO_SFTP_ENABLED=false
INVENTORY_SYNC_ENABLED=false
AMQUR_VAUTO_PUBLISH_PRICES=false
AMQUR_VAUTO_PUBLISH_PHOTOS=false
```

Additional production fail-closed defaults: empty `allowedOrigins` until install approval; sandbox ADF/scheduler only until verified recipients exist.

## Deployment sequence (staging)

1. CI green on integration branch.
2. Stamp release: `node scripts/stamp-release.mjs` (backend).
3. Deploy API then worker with correct Railway service names:
   - `backend-staging`
   - `worker-staging`
4. Confirm `GET /api/version` SHA matches intended commit.
5. Run `scripts/staging-acceptance.sh` (or hosted journey) against staging URLs.
6. Inventory: `AMQUR_SFTP_DIAGNOSTIC=1 node scripts/diagnose-vauto-sftp-readonly.mjs` on worker via `railway ssh` (never claim success from config alone).

## Migrations

- API start runs `prisma migrate deploy` when `PROCESS_ROLE` is not `worker`.
- Worker does **not** migrate (avoids race).
- Never reset production databases.

## Website install (when approved)

Documented per surface; **do not** modify vendor CMS until approved:

| Surface | Platform | Notes |
|---|---|---|
| dialdifference.com | Dial Auto Group platform | Concierge remains until AMQUR accepted; embed switch gated |
| Dial Chevy | DealerOn | Origin allowlist + single launcher |
| Dial Nissan | Apollo | Same |
| INFINITI of Chicago | Apollo | Same |
| Dial CDJR South | Apollo | Same |
| Jeep of Chicago North | Apollo | Same — never conflate with CDJR South |

## Monitoring / rollback

- Health: `/api/health`, `/api/health/live`, widget `/healthz`.
- Rollback staging: redeploy prior Railway deployment ID; see `amqur-backend/docs/ROLLBACK.md` and `docs/RELEASE_AND_ROLLBACK_RUNBOOK.md`.
- Do not force-push; do not bypass environment protection.

## SFTP diagnostic (staging only)

```bash
railway ssh -s worker-staging -e staging -- \
  'AMQUR_SFTP_DIAGNOSTIC=1 node scripts/diagnose-vauto-sftp-readonly.mjs'
```

Requires registered Railway SSH key for the AMQUR account. Does not enable ingest.
