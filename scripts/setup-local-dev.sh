#!/usr/bin/env bash
# One-shot local development setup. Safe to re-run (idempotent).
#
# What it does:
#   1. Ensures the local dockerized Postgres (amqur-postgres-local) is running
#   2. Verifies DATABASE_URL in .env.local points at localhost (never Railway)
#   3. prisma generate + prisma migrate deploy
#   4. Applies the local-dev-motors fixture tenant (localhost origins only)
#   5. If the API is running on :3000, verifies widget-config and
#      widget-token origin enforcement (201 allowed / 403 unauthorized)
#
# It never prints credentials and never touches remote databases.
set -euo pipefail

cd "$(dirname "$0")/.."

CONTAINER=amqur-postgres-local

# --- 1. local postgres -------------------------------------------------------
if ! docker ps --format '{{.Names}}' | grep -qx "${CONTAINER}"; then
  if docker ps -a --format '{{.Names}}' | grep -qx "${CONTAINER}"; then
    echo "==> starting existing ${CONTAINER}"
    docker start "${CONTAINER}" >/dev/null
  else
    echo "==> creating ${CONTAINER} (postgres:16, port 5432)"
    docker run -d --name "${CONTAINER}" \
      -e POSTGRES_USER=amqur \
      -e POSTGRES_PASSWORD=amqur-local-dev \
      -e POSTGRES_DB=amqur \
      -p 5432:5432 \
      postgres:16 >/dev/null
  fi
fi

echo "==> waiting for postgres to accept connections"
for i in $(seq 1 30); do
  if docker exec "${CONTAINER}" pg_isready -U amqur -d amqur >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "${CONTAINER}" pg_isready -U amqur -d amqur >/dev/null

# --- 2. env safety -----------------------------------------------------------
if [ ! -f .env.local ]; then
  echo "ERROR: .env.local missing. Copy .env.example and set local values." >&2
  exit 1
fi
DATABASE_URL="$(grep '^DATABASE_URL=' .env.local | cut -d= -f2- | tr -d '"')"
export DATABASE_URL
DB_HOST="$(node -e "console.log(new URL(process.env.DATABASE_URL).hostname)")"
case "${DB_HOST}" in
  localhost|127.0.0.1) ;;
  *)
    echo "ERROR: .env.local DATABASE_URL host is '${DB_HOST}' — refusing to run local setup against a non-local database." >&2
    exit 1
    ;;
esac
echo "==> DATABASE_URL host verified local (${DB_HOST})"

# --- 3. prisma ---------------------------------------------------------------
echo "==> prisma generate"
npx prisma generate >/dev/null
echo "==> prisma migrate deploy"
npx prisma migrate deploy
npx prisma migrate status | tail -1

# --- 4. fixture tenant -------------------------------------------------------
echo "==> applying local-dev-motors fixture"
npm run -s onboard:dealership -- --config docs/onboarding/tenants/local-dev.local.json | tail -2

# --- 5. optional live verification ------------------------------------------
API="http://localhost:3000/api"
if curl -sf --max-time 2 "${API}/public/health" >/dev/null 2>&1; then
  echo "==> API detected on :3000 — verifying widget endpoints"
  CFG=$(curl -s -o /dev/null -w '%{http_code}' "${API}/public/widget-config?tenantSlug=local-dev-motors&locationSlug=main")
  OK=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${API}/public/widget-token" \
    -H 'Origin: http://localhost:5173' -H 'Content-Type: application/json' \
    -d '{"tenantSlug":"local-dev-motors","locationSlug":"main"}')
  BAD=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${API}/public/widget-token" \
    -H 'Origin: https://evil.example' -H 'Content-Type: application/json' \
    -d '{"tenantSlug":"local-dev-motors","locationSlug":"main"}')
  echo "widget-config: ${CFG} (expect 200)"
  echo "widget-token allowed origin: ${OK} (expect 201)"
  echo "widget-token evil origin: ${BAD} (expect 403)"
  [ "${CFG}" = "200" ] && [ "${OK}" = "201" ] && [ "${BAD}" = "403" ] || {
    echo "ERROR: local widget endpoint verification failed" >&2
    exit 1
  }
else
  echo "==> API not running on :3000 — start it with 'npm run start:dev' and re-run this script to verify widget endpoints"
fi

echo "==> local development setup complete"
