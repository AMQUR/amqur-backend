#!/usr/bin/env bash
# Staging-only rollback helpers for amqur-platform-staging.
# Does NOT touch production projects.
set -euo pipefail
export PATH="${HOME}/.local/bin:${PATH}"

PROJECT_ID="${RAILWAY_STAGING_PROJECT_ID:-e4d54510-bbc0-45bc-9d5b-a19a5ad5132c}"
ENV_ID="${RAILWAY_STAGING_ENV_ID:-b58a4e5f-e8ad-4620-bc41-4874887c788e}"

usage() {
  cat <<EOF
Usage: $0 <command>

Commands:
  list-backend     List recent backend-staging deployments
  list-widget      List recent widget-staging deployments
  redeploy-backend Redeploy current backend-staging image/revision
  redeploy-widget  Redeploy current widget-staging image/revision
  disable-flags    Print Prisma note for disabling pilot flags (manual/safe)
  pause-note       Document queue pause (Redis workers not separate service yet)

Never run against divine-integrity or unlabeled projects.
EOF
}

cmd="${1:-}"
case "$cmd" in
  list-backend)
    railway environment staging
    railway deployment list --service backend-staging
    ;;
  list-widget)
    railway environment staging
    railway deployment list --service widget-staging
    ;;
  redeploy-backend)
    railway environment staging
    railway redeploy --service backend-staging -y
    ;;
  redeploy-widget)
    railway environment staging
    railway redeploy --service widget-staging -y
    ;;
  disable-flags)
    cat <<'EOF'
Safe feature-flag disablement (staging DB only):
  Update Tenant/Location featureFlags JSON for dial-auto-group-staging
  to set tekionIntegration, automatedFollowup, voiceAi, vAutoFeed = false.
  Prefer re-running: STAGING_ALLOWED_ORIGINS=... npm run seed:staging-pilot
  Do NOT prisma migrate reset.
EOF
    ;;
  pause-note)
    cat <<'EOF'
Queue pause: Nest app is single-instance on staging; INVENTORY_SYNC_ENABLED=false.
No separate worker service to pause. Redeploy previous backend revision to roll back code.
EOF
    ;;
  *)
    usage
    exit 1
    ;;
esac

echo "Project ${PROJECT_ID} env ${ENV_ID} (staging only)."
