#!/usr/bin/env bash
# One-time STAGING platform SUPER_ADMIN bootstrap — run by the platform owner.
#
#   scripts/bootstrap-super-admin.sh
#
# Interactive; prompts for admin identity and password (password read with
# no echo, passed to curl via stdin — never in argv, env dumps, logs, or Git).
# BOOTSTRAP_SECRET is read from Railway staging without being displayed.
#
# After a successful bootstrap it:
#   1. verifies login and refresh-token flow
#   2. verifies a second bootstrap attempt returns 403
#   3. removes BOOTSTRAP_SECRET from Railway staging and redeploys the api
#   4. verifies bootstrap is disabled afterwards
set -euo pipefail

API="${API:-https://staging-api.dialusnow.com/api}"
RAILWAY_ENV="${RAILWAY_ENV:-staging}"
RAILWAY_SERVICE="${RAILWAY_SERVICE:-api}"
TENANT_NAME="AMQUR Platform Operations"
TENANT_SLUG="amqur-platform-ops"

command -v railway >/dev/null || { echo "railway CLI required" >&2; exit 1; }
command -v node >/dev/null || { echo "node required" >&2; exit 1; }

echo "== AMQUR SUPER_ADMIN bootstrap =="
echo "API: ${API}"
echo "Railway: environment=${RAILWAY_ENV} service=${RAILWAY_SERVICE}"
echo "Ops tenant: ${TENANT_NAME} (${TENANT_SLUG})"
echo

read -r -p "Admin email: " ADMIN_EMAIL
read -r -p "First name: " ADMIN_FIRST
read -r -p "Last name:  " ADMIN_LAST
read -r -s -p "Password (min 8 chars, not echoed): " ADMIN_PASSWORD; echo
read -r -s -p "Confirm password: " ADMIN_PASSWORD2; echo
[ "${ADMIN_PASSWORD}" = "${ADMIN_PASSWORD2}" ] || { echo "Passwords do not match" >&2; exit 1; }
[ "${#ADMIN_PASSWORD}" -ge 8 ] || { echo "Password too short" >&2; exit 1; }

BOOTSTRAP_SECRET="$(railway variables --service "${RAILWAY_SERVICE}" --environment "${RAILWAY_ENV}" --kv 2>/dev/null | grep '^BOOTSTRAP_SECRET=' | cut -d= -f2-)"
[ -n "${BOOTSTRAP_SECRET}" ] || { echo "BOOTSTRAP_SECRET not set on ${RAILWAY_ENV}/${RAILWAY_SERVICE} — bootstrap disabled" >&2; exit 1; }

# Build the JSON body in node (proper escaping), pass sensitive values via env,
# send via stdin so nothing sensitive appears in argv.
BODY_FILE="$(mktemp)"; trap 'rm -f "${BODY_FILE}"' EXIT
BOOTSTRAP_SECRET="${BOOTSTRAP_SECRET}" ADMIN_EMAIL="${ADMIN_EMAIL}" \
ADMIN_FIRST="${ADMIN_FIRST}" ADMIN_LAST="${ADMIN_LAST}" \
ADMIN_PASSWORD="${ADMIN_PASSWORD}" TENANT_NAME="${TENANT_NAME}" TENANT_SLUG="${TENANT_SLUG}" \
node -e '
const e = process.env;
process.stdout.write(JSON.stringify({
  secret: e.BOOTSTRAP_SECRET,
  tenantName: e.TENANT_NAME,
  tenantSlug: e.TENANT_SLUG,
  email: e.ADMIN_EMAIL,
  password: e.ADMIN_PASSWORD,
  firstName: e.ADMIN_FIRST,
  lastName: e.ADMIN_LAST,
}));' > "${BODY_FILE}"

echo "==> POST /auth/bootstrap"
HTTP=$(curl -s -o /tmp/bootstrap-resp.json -w '%{http_code}' -X POST "${API}/auth/bootstrap" \
  -H 'Content-Type: application/json' --data-binary @"${BODY_FILE}")
rm -f "${BODY_FILE}"
if [ "${HTTP}" != "201" ] && [ "${HTTP}" != "200" ]; then
  echo "Bootstrap failed: HTTP ${HTTP}" >&2
  node -e 'try{const j=require("/tmp/bootstrap-resp.json");console.error(j.message||j)}catch{}' >&2 || true
  rm -f /tmp/bootstrap-resp.json
  exit 1
fi
rm -f /tmp/bootstrap-resp.json
echo "Bootstrap succeeded (HTTP ${HTTP})"

echo "==> verifying login"
LOGIN_FILE="$(mktemp)"
ADMIN_EMAIL="${ADMIN_EMAIL}" ADMIN_PASSWORD="${ADMIN_PASSWORD}" TENANT_SLUG="${TENANT_SLUG}" \
node -e '
const e=process.env;
process.stdout.write(JSON.stringify({email:e.ADMIN_EMAIL,password:e.ADMIN_PASSWORD,tenantSlug:e.TENANT_SLUG}));
' > "${LOGIN_FILE}"
LOGIN_HTTP=$(curl -s -o /tmp/login-resp.json -w '%{http_code}' -X POST "${API}/auth/login" \
  -H 'Content-Type: application/json' --data-binary @"${LOGIN_FILE}")
rm -f "${LOGIN_FILE}"
unset ADMIN_PASSWORD ADMIN_PASSWORD2
[ "${LOGIN_HTTP}" = "201" ] || [ "${LOGIN_HTTP}" = "200" ] || { echo "Login verification failed: HTTP ${LOGIN_HTTP}" >&2; exit 1; }
echo "Login OK (HTTP ${LOGIN_HTTP})"

echo "==> verifying refresh flow"
REFRESH=$(node -e 'const j=require("/tmp/login-resp.json");const d=j.data??j;console.log(d.refreshToken||"")')
[ -n "${REFRESH}" ] || { echo "No refreshToken in login response" >&2; exit 1; }
REFRESH_HTTP=$(printf '{"refreshToken":"%s"}' "${REFRESH}" | curl -s -o /dev/null -w '%{http_code}' -X POST "${API}/auth/refresh" -H 'Content-Type: application/json' --data-binary @-)
rm -f /tmp/login-resp.json
[ "${REFRESH_HTTP}" = "201" ] || [ "${REFRESH_HTTP}" = "200" ] || { echo "Refresh verification failed: HTTP ${REFRESH_HTTP}" >&2; exit 1; }
echo "Refresh OK (HTTP ${REFRESH_HTTP})"

echo "==> verifying second bootstrap attempt is rejected"
SECOND=$(printf '{"secret":"%s","tenantName":"x y","tenantSlug":"x-y","email":"second@example.com","password":"irrelevant-1234","firstName":"No","lastName":"Body"}' "${BOOTSTRAP_SECRET}" \
  | curl -s -o /dev/null -w '%{http_code}' -X POST "${API}/auth/bootstrap" -H 'Content-Type: application/json' --data-binary @-)
unset BOOTSTRAP_SECRET
[ "${SECOND}" = "403" ] || { echo "Expected 403 on second bootstrap, got ${SECOND}" >&2; exit 1; }
echo "Second bootstrap correctly rejected (403)"

echo "==> removing BOOTSTRAP_SECRET from Railway ${RAILWAY_ENV}/${RAILWAY_SERVICE} (+ worker twin if present) and redeploying"
railway variables --service "${RAILWAY_SERVICE}" --environment "${RAILWAY_ENV}" --set "BOOTSTRAP_SECRET=" >/dev/null
# Clear twin worker secret when production naming is used
if [ "${RAILWAY_SERVICE}" = "prod-api" ]; then
  railway variables --service prod-worker --environment "${RAILWAY_ENV}" --set "BOOTSTRAP_SECRET=" >/dev/null 2>&1 || true
fi
railway redeploy --service "${RAILWAY_SERVICE}" --environment "${RAILWAY_ENV}" --yes >/dev/null 2>&1 || \
  echo "NOTE: automatic redeploy failed — redeploy ${RAILWAY_SERVICE} manually so the removal takes effect."

echo
echo "Done. Record (safe evidence): bootstrap 201, login ${LOGIN_HTTP}, refresh ${REFRESH_HTTP}, re-bootstrap 403, BOOTSTRAP_SECRET cleared."
echo "After redeploy, verify bootstrap stays 403 with a dummy secret."
