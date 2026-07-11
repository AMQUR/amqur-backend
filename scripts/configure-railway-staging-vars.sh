#!/usr/bin/env bash
# Configure staging-only Railway variables for backend-staging.
# Does not print secret values.
set -euo pipefail
export PATH="${HOME}/.local/bin:${PATH}"

SERVICE="${1:-backend-staging}"

if ! railway whoami >/dev/null 2>&1; then
  echo "ERROR: railway not authenticated" >&2
  exit 1
fi

JWT_SECRET=$(openssl rand -hex 48)
JWT_REFRESH=$(openssl rand -hex 48)
BOOTSTRAP_SECRET=$(openssl rand -hex 24)
INTEGRATION_KEY=$(openssl rand -hex 32)

# Store labels in Keychain (macOS) — values not echoed
if command -v security >/dev/null 2>&1; then
  security add-generic-password -U -a "amqur" -s "AMQUR Staging JWT" -w "${JWT_SECRET}" 2>/dev/null || true
  security add-generic-password -U -a "amqur" -s "AMQUR Staging Bootstrap" -w "${BOOTSTRAP_SECRET}" 2>/dev/null || true
  echo "Keychain labels stored: AMQUR Staging JWT, AMQUR Staging Bootstrap"
fi

# Link service
railway service "${SERVICE}" >/dev/null 2>&1 || true

# Use Railway reference variables for DB/Redis — never hardcode credentials
railway variable set \
  "NODE_ENV=production" \
  "PORT=3000" \
  "DATABASE_URL=\${{Postgres.DATABASE_URL}}" \
  "REDIS_URL=\${{Redis.REDIS_URL}}" \
  "JWT_SECRET=${JWT_SECRET}" \
  "JWT_EXPIRES_IN=15m" \
  "JWT_REFRESH_EXPIRES_IN=7d" \
  "WIDGET_TOKEN_EXPIRES_IN=4h" \
  "BOOTSTRAP_SECRET=${BOOTSTRAP_SECRET}" \
  "INTEGRATION_ENCRYPTION_KEY=${INTEGRATION_KEY}" \
  "INVENTORY_SYNC_ENABLED=false" \
  "CRM_WEBHOOK_URL=" \
  "ANTHROPIC_API_KEY=" \
  --service "${SERVICE}" 2>&1 | sed 's/=.*/=***REDACTED***/g' || {
  # Older CLI syntax fallback
  railway variables --set "NODE_ENV=production" --service "${SERVICE}" || true
}

# Clear local secret vars
unset JWT_SECRET JWT_REFRESH BOOTSTRAP_SECRET INTEGRATION_KEY

echo "Staging variables configured for service ${SERVICE} (secrets redacted)."
