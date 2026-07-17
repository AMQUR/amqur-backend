#!/usr/bin/env bash
# Provision the AMQUR PRODUCTION environment inside dial-us-now-platform.
#
# ============================ OWNER GATE =============================
# Creating production Postgres/Redis and deploying services is BILLABLE
# and outward-facing preparation. Run only with OWNER_APPROVED=1.
#
# This script does NOT:
#   - attach api.dialusnow.com / widget.dialusnow.com (separate DNS checkpoint)
#   - merge any PR
#   - invent DNS CNAME/TXT values
#   - copy staging DATABASE_URL / REDIS_URL / JWT / encryption secrets
#   - enable inventory/payments/CRM/vendor integrations
# =====================================================================
#
# Usage: OWNER_APPROVED=1 scripts/provision-railway-production.sh
set -euo pipefail
export PATH="${HOME}/.local/bin:${PATH}"

if [ "${OWNER_APPROVED:-0}" != "1" ]; then
  echo "Refusing to run: set OWNER_APPROVED=1 after explicit owner approval (billable resources)." >&2
  exit 1
fi

ENV=production
BACKEND_REPO="${BACKEND_REPO:-AMQUR/amqur-backend}"
WIDGET_REPO="${WIDGET_REPO:-AMQUR/amqur-widget}"
BRANCH="${DEPLOY_BRANCH:-production-readiness/pilot-prep}"
cd "$(dirname "$0")/.."

echo "==> Project / environment"
railway status --environment "${ENV}" 2>&1 | head -20 || true

echo "==> Ensuring production Postgres + Redis (idempotent)"
railway add --database postgres --environment "${ENV}" --json 2>/dev/null || \
  railway add --database postgres --environment "${ENV}" 2>&1 | tail -3 || true
railway add --database redis --environment "${ENV}" --json 2>/dev/null || \
  railway add --database redis --environment "${ENV}" 2>&1 | tail -3 || true

echo "==> Ensuring production services (api / worker / widget) from GitHub"
# Empty named services first if repo-link requires interactive auth; then link.
for svc in api worker; do
  railway add --service "${svc}" --environment "${ENV}" --json 2>/dev/null || \
    railway add --service "${svc}" --environment "${ENV}" 2>&1 | tail -2 || true
done
railway add --service widget --environment "${ENV}" --json 2>/dev/null || \
  railway add --service widget --environment "${ENV}" 2>&1 | tail -2 || true

echo "==> Generating fresh production secrets (values never printed)"
node <<'EOF'
const crypto = require('crypto');
const { execFileSync } = require('child_process');

function set(svc, pairs) {
  const args = [
    'variables',
    '--service', svc,
    '--environment', 'production',
    '--skip-deploys',
  ];
  for (const [k, v] of pairs) {
    args.push('--set', `${k}=${v}`);
  }
  try {
    execFileSync('railway', args, { stdio: ['ignore', 'ignore', 'inherit'] });
  } catch {
    // Never include argv (secrets) in error output.
    console.error(`WARN: could not set variables on ${svc} (see railway CLI stderr)`);
    throw new Error(`variable set failed for ${svc}`);
  }
}

const secret = () => crypto.randomBytes(48).toString('base64url');
const shared = [
  ['JWT_SECRET', secret()],
  ['WIDGET_TOKEN_SECRET', secret()],
  ['INTEGRATION_ENCRYPTION_KEY', secret()],
  // Bootstrap secret only for first SUPER_ADMIN; remove after init.
  ['BOOTSTRAP_SECRET', secret()],
  ['NODE_ENV', 'production'],
  ['CANARY_ENVIRONMENT', 'production'],
  ['CANARY_EMPLOYEE_ENABLED', 'false'],
  ['INVENTORY_SYNC_ENABLED', 'false'],
  ['JWT_EXPIRES_IN', '15m'],
  ['JWT_REFRESH_EXPIRES_IN', '7d'],
  ['WIDGET_TOKEN_EXPIRES_IN', '4h'],
  ['PUBLIC_API_URL', 'https://api.dialusnow.com'],
  ['PUBLIC_WIDGET_URL', 'https://widget.dialusnow.com'],
  ['CORS_ORIGINS', 'https://widget.dialusnow.com'],
  ['API_MAX_REPLICAS', '1'],
];

for (const svc of ['api', 'worker']) {
  try {
    set(svc, shared);
  } catch {
    console.error(`WARN: skipped shared vars for ${svc}`);
  }
}
try {
  set('api', [
    ['PROCESS_ROLE', 'api'],
    ['OUTBOX_PROCESSOR_ENABLED', 'false'],
  ]);
  set('worker', [
    ['PROCESS_ROLE', 'worker'],
    ['OUTBOX_PROCESSOR_ENABLED', 'true'],
  ]);
} catch {
  console.error('WARN: role variables incomplete');
}
console.log('production secrets + role variables set (values never displayed)');
EOF

echo
echo "==> Production resource snapshot"
railway status --environment "${ENV}" 2>&1 | head -40

cat <<'MSG'

==> MANUAL / NEXT STEPS (script cannot safely invent these)
  1. In Railway dashboard → production → api + worker:
     - Reference Postgres.DATABASE_URL → DATABASE_URL
     - Reference Redis.REDIS_URL → REDIS_URL
     Confirm these are NOT staging connection strings.
  2. Keep API replicas = 1 until Redis throttler storage is shipped
     (in-memory TenantThrottlerGuard is not multi-replica safe).
  3. Set ERROR_MONITORING_DSN when alert delivery can be proven.
  4. Deploy api/worker/widget from the release branch / main after merge.
  5. Run production migrations via api startCommand (prisma migrate deploy).
  6. Bootstrap SUPER_ADMIN, then clear BOOTSTRAP_SECRET.
  7. Attach custom domains only after smoke on Railway temp domains;
     copy EXACT DNS targets Railway prints — never invent them.

MSG
