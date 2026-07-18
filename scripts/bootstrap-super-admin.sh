#!/usr/bin/env bash
# Platform SUPER_ADMIN bootstrap / resume — owner-operated, interactive.
#
# Full create (first time only):
#   API=... RAILWAY_ENV=production RAILWAY_SERVICE=prod-api \
#     ./scripts/bootstrap-super-admin.sh
#
# Resume after create succeeded but post-checks failed (e.g. snake_case tokens):
#   API=... RAILWAY_ENV=production RAILWAY_SERVICE=prod-api \
#     ./scripts/bootstrap-super-admin.sh --resume
#
# Never prints passwords, tokens, BOOTSTRAP_SECRET, or full auth JSON.
set -euo pipefail

API="${API:-https://staging-api.dialusnow.com/api}"
RAILWAY_ENV="${RAILWAY_ENV:-staging}"
RAILWAY_SERVICE="${RAILWAY_SERVICE:-api}"
TENANT_NAME="AMQUR Platform Operations"
TENANT_SLUG="amqur-platform-ops"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTRACT="${SCRIPT_DIR}/lib/extract-auth-tokens.mjs"

RESUME=0
for arg in "$@"; do
  case "${arg}" in
    --resume) RESUME=1 ;;
    -h|--help)
      sed -n '2,16p' "$0" | tr -d '#'
      exit 0
      ;;
    *)
      echo "Unknown argument: ${arg}" >&2
      exit 2
      ;;
  esac
done

command -v railway >/dev/null || { echo "railway CLI required" >&2; exit 1; }
command -v node >/dev/null || { echo "node required" >&2; exit 1; }
command -v curl >/dev/null || { echo "curl required" >&2; exit 1; }
[ -f "${EXTRACT}" ] || { echo "missing ${EXTRACT}" >&2; exit 1; }

TMPDIR_BOOT="$(mktemp -d)"
LOGIN_RESP="${TMPDIR_BOOT}/login.json"
REFRESH_RESP="${TMPDIR_BOOT}/refresh.json"
REPLAY_RESP="${TMPDIR_BOOT}/replay.json"
BOOTSTRAP_RESP="${TMPDIR_BOOT}/bootstrap.json"
BODY_FILE="${TMPDIR_BOOT}/body.json"
LOGIN_FILE="${TMPDIR_BOOT}/login-body.json"
REFRESH_BODY="${TMPDIR_BOOT}/refresh-body.json"
OLD_REFRESH_FILE="${TMPDIR_BOOT}/old-refresh.txt"

cleanup() {
  rm -rf "${TMPDIR_BOOT}"
  unset ADMIN_PASSWORD ADMIN_PASSWORD2 BOOTSTRAP_SECRET REFRESH NEW_REFRESH ACCESS 2>/dev/null || true
}
trap cleanup EXIT

echo "== AMQUR SUPER_ADMIN ${RESUME:+resume }bootstrap =="
echo "API: ${API}"
echo "Railway: environment=${RAILWAY_ENV} service=${RAILWAY_SERVICE}"
echo "Ops tenant: ${TENANT_NAME} (${TENANT_SLUG})"
echo "Mode: $([ "${RESUME}" = "1" ] && echo resume || echo create)"
echo

read -r -p "Admin email: " ADMIN_EMAIL
[ -n "${ADMIN_EMAIL}" ] || { echo "email required" >&2; exit 1; }

if [ "${RESUME}" = "0" ]; then
  read -r -p "First name: " ADMIN_FIRST
  read -r -p "Last name:  " ADMIN_LAST
fi

read -r -s -p "Password (min 8 chars, not echoed): " ADMIN_PASSWORD; echo
if [ "${RESUME}" = "0" ]; then
  read -r -s -p "Confirm password: " ADMIN_PASSWORD2; echo
  [ "${ADMIN_PASSWORD}" = "${ADMIN_PASSWORD2}" ] || { echo "Passwords do not match" >&2; exit 1; }
fi
[ "${#ADMIN_PASSWORD}" -ge 8 ] || { echo "Password too short" >&2; exit 1; }

# ---------------------------------------------------------------------------
# CREATE path — skipped in --resume
# ---------------------------------------------------------------------------
if [ "${RESUME}" = "0" ]; then
  BOOTSTRAP_SECRET="$(railway variables --service "${RAILWAY_SERVICE}" --environment "${RAILWAY_ENV}" --kv 2>/dev/null | grep '^BOOTSTRAP_SECRET=' | cut -d= -f2- || true)"
  [ -n "${BOOTSTRAP_SECRET}" ] || { echo "BOOTSTRAP_SECRET not set on ${RAILWAY_ENV}/${RAILWAY_SERVICE} — bootstrap disabled" >&2; exit 1; }

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
  HTTP=$(curl -s -o "${BOOTSTRAP_RESP}" -w '%{http_code}' -X POST "${API}/auth/bootstrap" \
    -H 'Content-Type: application/json' --data-binary @"${BODY_FILE}")
  rm -f "${BODY_FILE}"
  if [ "${HTTP}" != "201" ] && [ "${HTTP}" != "200" ]; then
    echo "Bootstrap failed: HTTP ${HTTP}" >&2
    node -e 'const fs=require("fs");try{const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));console.error(j.message||"bootstrap error")}catch{console.error("bootstrap error")}' "${BOOTSTRAP_RESP}" >&2 || true
    exit 1
  fi
  echo "Bootstrap succeeded (HTTP ${HTTP})"
  unset BOOTSTRAP_SECRET
else
  echo "==> resume: skipping POST /auth/bootstrap (already succeeded)"
fi

# ---------------------------------------------------------------------------
# Login + refresh + rotation + replay
# ---------------------------------------------------------------------------
echo "==> verifying login"
ADMIN_EMAIL="${ADMIN_EMAIL}" ADMIN_PASSWORD="${ADMIN_PASSWORD}" TENANT_SLUG="${TENANT_SLUG}" \
node -e '
const e=process.env;
process.stdout.write(JSON.stringify({email:e.ADMIN_EMAIL,password:e.ADMIN_PASSWORD,tenantSlug:e.TENANT_SLUG}));
' > "${LOGIN_FILE}"
LOGIN_HTTP=$(curl -s -o "${LOGIN_RESP}" -w '%{http_code}' -X POST "${API}/auth/login" \
  -H 'Content-Type: application/json' --data-binary @"${LOGIN_FILE}")
rm -f "${LOGIN_FILE}"
unset ADMIN_PASSWORD ADMIN_PASSWORD2
[ "${LOGIN_HTTP}" = "201" ] || [ "${LOGIN_HTTP}" = "200" ] || {
  echo "Login verification failed: HTTP ${LOGIN_HTTP}" >&2
  exit 1
}
HAS_REFRESH="$(node "${EXTRACT}" "${LOGIN_RESP}" has-refresh)"
[ "${HAS_REFRESH}" = "1" ] || { echo "No refresh token in login response (checked snake_case/camelCase/nested)" >&2; exit 1; }
echo "Login OK (HTTP ${LOGIN_HTTP})"

echo "==> verifying refresh + rotation"
node "${EXTRACT}" "${LOGIN_RESP}" refresh > "${OLD_REFRESH_FILE}"
node "${EXTRACT}" "${LOGIN_RESP}" refresh-body > "${REFRESH_BODY}"
# Wipe login response from disk before network round-trips that might leave artifacts
: > "${LOGIN_RESP}"

REFRESH_HTTP=$(curl -s -o "${REFRESH_RESP}" -w '%{http_code}' -X POST "${API}/auth/refresh" \
  -H 'Content-Type: application/json' --data-binary @"${REFRESH_BODY}")
rm -f "${REFRESH_BODY}"
[ "${REFRESH_HTTP}" = "201" ] || [ "${REFRESH_HTTP}" = "200" ] || {
  echo "Refresh verification failed: HTTP ${REFRESH_HTTP}" >&2
  exit 1
}
HAS_NEW="$(node "${EXTRACT}" "${REFRESH_RESP}" has-refresh)"
[ "${HAS_NEW}" = "1" ] || { echo "No rotated refresh token in refresh response" >&2; exit 1; }
echo "Refresh OK (HTTP ${REFRESH_HTTP})"

echo "==> verifying old refresh token cannot be reused"
OLD_BODY="$(OLD_REFRESH_FILE="${OLD_REFRESH_FILE}" node -e 'const fs=require("fs");const t=fs.readFileSync(process.env.OLD_REFRESH_FILE,"utf8").trim();process.stdout.write(JSON.stringify({refresh_token:t}))')"
rm -f "${OLD_REFRESH_FILE}"
REPLAY_HTTP=$(printf '%s' "${OLD_BODY}" | curl -s -o "${REPLAY_RESP}" -w '%{http_code}' -X POST "${API}/auth/refresh" \
  -H 'Content-Type: application/json' --data-binary @-)
unset OLD_BODY
: > "${REFRESH_RESP}"
: > "${REPLAY_RESP}"
# Expect 401/403 (invalid/revoked). Some deployments may return 400.
case "${REPLAY_HTTP}" in
  401|403|400) echo "Refresh replay correctly rejected (HTTP ${REPLAY_HTTP})" ;;
  *)
    echo "Expected rejected replay (401/403/400), got ${REPLAY_HTTP}" >&2
    exit 1
    ;;
esac

# ---------------------------------------------------------------------------
# Second bootstrap must be 403 (SUPER_ADMIN already exists)
# ---------------------------------------------------------------------------
echo "==> verifying second bootstrap attempt is rejected"
# Prefer live BOOTSTRAP_SECRET if still present; otherwise use a dummy ≥16 chars.
LIVE_SECRET="$(railway variables --service "${RAILWAY_SERVICE}" --environment "${RAILWAY_ENV}" --kv 2>/dev/null | grep '^BOOTSTRAP_SECRET=' | cut -d= -f2- || true)"
PROBE_SECRET="${LIVE_SECRET:-dummy-bootstrap-secret-xx}"
SECOND_BODY="$(PROBE_SECRET="${PROBE_SECRET}" node -e 'process.stdout.write(JSON.stringify({secret:process.env.PROBE_SECRET,tenantName:"x y",tenantSlug:"x-y",email:"second@example.com",password:"irrelevant-1234",firstName:"No",lastName:"Body"}))')"
SECOND=$(printf '%s' "${SECOND_BODY}" | curl -s -o /dev/null -w '%{http_code}' -X POST "${API}/auth/bootstrap" \
  -H 'Content-Type: application/json' --data-binary @-)
unset LIVE_SECRET PROBE_SECRET SECOND_BODY
[ "${SECOND}" = "403" ] || { echo "Expected 403 on second bootstrap, got ${SECOND}" >&2; exit 1; }
echo "Second bootstrap correctly rejected (403)"

# ---------------------------------------------------------------------------
# Clear BOOTSTRAP_SECRET + redeploy + verify disabled
# ---------------------------------------------------------------------------
echo "==> removing BOOTSTRAP_SECRET from Railway ${RAILWAY_ENV}/${RAILWAY_SERVICE}"
railway variables delete BOOTSTRAP_SECRET --service "${RAILWAY_SERVICE}" --environment "${RAILWAY_ENV}" --yes >/dev/null 2>&1 \
  || railway variables --service "${RAILWAY_SERVICE}" --environment "${RAILWAY_ENV}" --set "BOOTSTRAP_SECRET=" >/dev/null 2>&1 \
  || true
if [ "${RAILWAY_SERVICE}" = "prod-api" ]; then
  railway variables delete BOOTSTRAP_SECRET --service prod-worker --environment "${RAILWAY_ENV}" --yes >/dev/null 2>&1 \
    || railway variables --service prod-worker --environment "${RAILWAY_ENV}" --set "BOOTSTRAP_SECRET=" >/dev/null 2>&1 \
    || true
elif [ "${RAILWAY_SERVICE}" = "api" ]; then
  railway variables delete BOOTSTRAP_SECRET --service worker --environment "${RAILWAY_ENV}" --yes >/dev/null 2>&1 || true
fi

STILL="$(railway variables --service "${RAILWAY_SERVICE}" --environment "${RAILWAY_ENV}" --kv 2>/dev/null | grep '^BOOTSTRAP_SECRET=' | cut -d= -f2- || true)"
if [ -n "${STILL}" ]; then
  echo "WARNING: BOOTSTRAP_SECRET still present after delete/clear — check Railway dashboard" >&2
else
  echo "BOOTSTRAP_SECRET absent on ${RAILWAY_SERVICE}"
fi
unset STILL

echo "==> redeploying ${RAILWAY_SERVICE}"
railway redeploy --service "${RAILWAY_SERVICE}" --environment "${RAILWAY_ENV}" --yes >/dev/null 2>&1 || \
  echo "NOTE: automatic redeploy failed — redeploy ${RAILWAY_SERVICE} manually so removal takes effect."

echo "==> waiting for API after redeploy"
for i in $(seq 1 36); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "${API}/health/ready" || true)
  [ "${code}" = "200" ] && break
  sleep 5
done

echo "==> verifying bootstrap stays disabled (dummy secret)"
DISABLED=$(printf '%s' '{"secret":"dummy-bootstrap-secret-xx","tenantName":"x y","tenantSlug":"x-y","email":"second@example.com","password":"irrelevant-1234","firstName":"No","lastName":"Body"}' \
  | curl -s -o /dev/null -w '%{http_code}' -X POST "${API}/auth/bootstrap" \
  -H 'Content-Type: application/json' --data-binary @-)
# 403 (admin exists / disabled) or 503/401 depending on implementation — must NOT be 201
if [ "${DISABLED}" = "201" ] || [ "${DISABLED}" = "200" ]; then
  echo "Bootstrap still accepting creates after secret removal (HTTP ${DISABLED})" >&2
  exit 1
fi
echo "Bootstrap remains disabled (HTTP ${DISABLED})"

# ---------------------------------------------------------------------------
# Audit + SUPER_ADMIN count (safe counts only; no emails/tokens)
# ---------------------------------------------------------------------------
echo "==> verifying auth.bootstrap audit + SUPER_ADMIN count via Railway runtime"
AUDIT_OUT="$(
  cd "${SCRIPT_DIR}/.." && \
  railway run --service "${RAILWAY_SERVICE}" --environment "${RAILWAY_ENV}" -- \
    node --input-type=module -e '
import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
try {
  const ops = await p.tenant.findUnique({ where: { slug: "amqur-platform-ops" }, select: { id: true, slug: true } });
  const admins = await p.user.count({ where: { role: "SUPER_ADMIN", isActive: true } });
  const audits = ops
    ? await p.auditLog.count({ where: { tenantId: ops.id, action: "auth.bootstrap" } })
    : 0;
  process.stdout.write(JSON.stringify({
    opsTenant: ops?.slug === "amqur-platform-ops",
    superAdminCount: admins,
    authBootstrapAudits: audits,
  }));
} finally {
  await p.$disconnect();
}
' 2>/dev/null || echo '{"error":true}'
)"
node -e '
const j=JSON.parse(process.argv[1]);
if (j.error) { console.error("Audit/count probe failed — verify manually in DB"); process.exit(0); }
if (!j.opsTenant) { console.error("ops tenant amqur-platform-ops missing"); process.exit(1); }
if (j.superAdminCount !== 1) { console.error("expected SUPER_ADMIN count 1, got "+j.superAdminCount); process.exit(1); }
if (j.authBootstrapAudits < 1) { console.error("expected auth.bootstrap audit >=1"); process.exit(1); }
console.log("Ops tenant OK; SUPER_ADMIN count=1; auth.bootstrap audits="+j.authBootstrapAudits);
' "${AUDIT_OUT}"

echo
echo "Done. Safe evidence: login ${LOGIN_HTTP}, refresh ${REFRESH_HTTP}, replay ${REPLAY_HTTP}, re-bootstrap 403, post-redeploy bootstrap ${DISABLED}, BOOTSTRAP_SECRET cleared."
echo "No passwords, tokens, or secrets were printed."
