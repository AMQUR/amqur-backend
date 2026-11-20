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

# Provenance travels as Railway service variables (railway up excludes
# gitignored files like release.json from the build context; GET
# /api/version prefers APP_* env vars).
COMMIT_SHA="$(git rev-parse HEAD)"
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RELEASE_ID="$(node -e 'console.log(require("crypto").randomUUID())')"
VERSION="$(node -e 'console.log(require("./package.json").version)')"

deploy_service() {
  local svc="$1"
  railway variables --service "${svc}" --environment "${ENV_NAME}" \
    --set "APP_COMMIT_SHA=${COMMIT_SHA}" \
    --set "APP_BUILD_TIME=${BUILD_TIME}" \
    --set "APP_RELEASE_ID=${RELEASE_ID}" \
    --set "APP_RELEASE_VERSION=${VERSION}" \
    --skip-deploys >/dev/null
  echo "==> railway up --service ${svc} --environment ${ENV_NAME}"
  railway up --service "${svc}" --environment "${ENV_NAME}" --ci
}

# Isolated staging service names (amqur-platform-staging).
case "${TARGET}" in
  api|backend-staging) deploy_service backend-staging ;;
  worker|worker-staging) deploy_service worker-staging ;;
  all)
    deploy_service backend-staging
    deploy_service worker-staging
    ;;
  *)
    echo "Usage: $0 [api|worker|all|backend-staging|worker-staging]" >&2
    exit 1
    ;;
esac

EXPECTED_SHA="$(git rev-parse HEAD)"
STAGING_API_URL="${STAGING_API_URL:-https://backend-staging-staging-b699.up.railway.app}"
# API /version only moves when backend-staging is deployed.
case "${TARGET}" in
  worker|worker-staging)
    echo "==> worker-only deploy: skip API /version check (expected SHA ${EXPECTED_SHA})"
    echo "    Confirm worker stamp via: railway ssh -s worker-staging -- 'node -e \"console.log(require(\\\"./release.json\\\").commitSha)\"'"
    ;;
  *)
    echo "==> verifying deployed API release identity"
    scripts/verify-release.sh "${STAGING_API_URL}" "${EXPECTED_SHA}" || {
      echo "WARNING: release verification failed — deployed commit does not match ${EXPECTED_SHA}" >&2
      exit 1
    }
    ;;
esac
