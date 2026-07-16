# Runbook

## Deploy API

1. Merge green CI PR
2. Railway deploy `api` (migrate on start)
3. Verify `/api/health` ready
4. Smoke: widget-config + widget-token + chat (staging tenant)

## Deploy worker

1. Same image; start `node dist/worker.js`
2. Confirm outbox PENDING drains

## Rollback

1. Redeploy previous Railway deployment
2. Do **not** auto-downgrade migrations that drop columns; prefer expand/contract
3. Disable risky flags immediately if needed

## Onboard rooftop

`POST /api/onboarding/dealership` (SUPER_ADMIN) or `npm run onboard:dealership -- --config ...`

## Inventory empty after feed enable

1. Check import runs
2. SSRF/allowlist
3. Anomaly rejection
4. Keep `inventory` flag false until fresh vehicles present
