#!/usr/bin/env bash
# Provision the AMQUR PRODUCTION environment inside dial-us-now-platform.
#
# ============================ OWNER GATE =============================
# Creating production Postgres/Redis and deploying services is BILLABLE
# and outward-facing preparation. Run this script only after explicit
# owner approval. It still does NOT:
#   - attach api.dialusnow.com / widget.dialusnow.com custom domains
#   - change any public DNS
#   - merge any PR
# Domain attachment + DNS remain a separate manual owner step; record the
# Railway-generated DNS target values exactly as the dashboard/CLI prints
# them — never invent them.
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
cd "$(dirname "$0")/.."

echo "==> Ensuring production databases exist (idempotent adds)"
railway add --database postgres --environment "${ENV}" 2>&1 | tail -1 || true
railway add --database redis --environment "${ENV}" 2>&1 | tail -1 || true

echo "==> Generating fresh production secrets (never displayed, never reused from staging)"
node <<'EOF'
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const set = (svc, kv) =>
  execFileSync(
    'railway',
    ['variables', '--service', svc, '--environment', 'production', '--skip-deploys',
     ...kv.flatMap(([k, v]) => ['--set', `${k}=${v}`])],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
const secret = () => crypto.randomBytes(48).toString('base64url');
const shared = [
  ['JWT_SECRET', secret()],
  ['WIDGET_TOKEN_SECRET', secret()],
  ['INTEGRATION_ENCRYPTION_KEY', secret()],
  ['NODE_ENV', 'production'],
  ['CANARY_ENVIRONMENT', 'production'],
  ['CANARY_EMPLOYEE_ENABLED', 'false'],
  ['INVENTORY_SYNC_ENABLED', 'false'],
  ['JWT_EXPIRES_IN', '15m'],
  ['JWT_REFRESH_EXPIRES_IN', '7d'],
  ['WIDGET_TOKEN_EXPIRES_IN', '4h'],
];
for (const svc of ['api', 'worker']) set(svc, shared);
set('api', [['PROCESS_ROLE', 'api'], ['OUTBOX_PROCESSOR_ENABLED', 'true']]);
set('worker', [['PROCESS_ROLE', 'worker'], ['OUTBOX_PROCESSOR_ENABLED', 'true']]);
console.log('production secrets + role variables set (values never displayed)');
EOF

echo
echo "==> REMAINING MANUAL OWNER STEPS (do NOT automate):"
echo "  1. Wire DATABASE_URL / REDIS_URL references from the production Postgres/Redis"
echo "     services to api + worker (Railway dashboard reference variables)."
echo "  2. Set CORS_ORIGINS + PUBLIC_API_URL + PUBLIC_WIDGET_URL for production."
echo "  3. Set ERROR_MONITORING_DSN (production project in the error monitor)."
echo "  4. Deploy: scripts/deploy-staging.sh pattern with --environment production,"
echo "     or the deploy.yml GitHub workflow after merging."
echo "  5. Verify Railway volume backups on the production Postgres volume."
echo "  6. Only with final owner approval: attach api.dialusnow.com and"
echo "     widget.dialusnow.com in Railway and copy the EXACT DNS target values"
echo "     Railway shows into the DNS provider."
