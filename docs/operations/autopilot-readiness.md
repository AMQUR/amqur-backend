# Autopilot readiness — Dial Us Now

**Date:** 2026-07-17  
**Project:** `dial-us-now-platform`

## What is automated today

| Step | Status |
|------|--------|
| PR CI (typecheck/lint/test/build/migrations-empty-db/docker) | YES |
| Staging custom domains + TLS | YES |
| Production Postgres + Redis (isolated) | YES |
| Production API/worker/widget services (`prod-*`) | YES (temp Railway domains) |
| Production migrate-on-start | YES (api startCommand) |
| Fail-closed feature defaults | YES |
| Single API replica restriction (`API_MAX_REPLICAS=1`) | Documented / env set — Redis throttler storage **not** yet |

## What still requires a human

| Gate | Status |
|------|--------|
| Production Squarespace DNS for `api` / `widget` | **OWNER DNS CHECKPOINT** |
| First production SUPER_ADMIN bootstrap | **OWNER INTERACTIVE** |
| `ERROR_MONITORING_DSN` + alert-delivery proof | OPEN |
| Railway Postgres snapshot schedule confirmation in UI | OPEN |
| Human employee canary results | OPEN |
| Verified dealership origins | OPEN — keep empty |
| Team Velocity / store install approval | OPEN |
| Public dealership traffic | **NO** |

## CI/CD desired flow

Feature branch → PR → required CI → merge to main → staging deploy → staging smoke → **manual production approval** → production deploy → production smoke → rollback on critical failure.

GitHub `RAILWAY_TOKEN` and production environment reviewers should be configured before fully unattended production promotion.
