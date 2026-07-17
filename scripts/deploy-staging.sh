#!/usr/bin/env bash
# Deploy the backend (api + worker) to Railway STAGING with provenance.
#
# Usage: scripts/deploy-staging.sh [api|worker|all]
#
# - Stamps release.json (commit SHA, build time, release id) so the deployed
#   image reports its identity via GET /api/version.
# - Refuses to deploy a dirty working tree unless ALLOW_DIRTY=1.
# - Never prints secrets.
set -euo pipefail

cd "$(dirname "$0")/.."

TARGET="${1:-all}"
ENV_NAME="staging"

if [ -n "$(git status --porcelain)" ] && [ "${ALLOW_DIRTY:-0}" != "1" ]; then
  echo "ERROR: working tree is dirty. Commit first or set ALLOW_DIRTY=1." >&2
  exit 1
fi

node scripts/stamp-release.mjs

deploy_service() {
  local svc="$1"
  echo "==> railway up --service ${svc} --environment ${ENV_NAME}"
  railway up --service "${svc}" --environment "${ENV_NAME}" --ci
}

case "${TARGET}" in
  api) deploy_service api ;;
  worker) deploy_service worker ;;
  all)
    deploy_service api
    deploy_service worker
    ;;
  *)
    echo "Usage: $0 [api|worker|all]" >&2
    exit 1
    ;;
esac

echo "==> verifying deployed release identity"
EXPECTED_SHA="$(git rev-parse HEAD)"
scripts/verify-release.sh "https://staging-api.dialusnow.com" "${EXPECTED_SHA}" || {
  echo "WARNING: release verification failed — deployed commit does not match ${EXPECTED_SHA}" >&2
  exit 1
}
