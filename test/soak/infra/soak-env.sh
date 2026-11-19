#!/usr/bin/env bash
# Environment for the ISOLATED soak stack (compose project `amqur-soak`, test/soak/infra/compose.soak.yml).
# Source it, or use it as a wrapper:   bash test/soak/infra/soak-env.sh <command...>
# Disposable local values only. Refuses to continue unless DATABASE_URL points at the soak
# Postgres port on loopback, so a soak run can never hit the shared test stack (:55432),
# the local demo or anything remote.
SOAK_PG_PORT="${SOAK_PG_PORT:-57432}"
SOAK_REDIS_PORT="${SOAK_REDIS_PORT:-57379}"
SOAK_SMTP_PORT="${SOAK_SMTP_PORT:-12025}"
SOAK_SMTP_HTTP_PORT="${SOAK_SMTP_HTTP_PORT:-19085}"
SOAK_CRM_PORT="${SOAK_CRM_PORT:-19081}"
export SOAK_PG_PORT SOAK_REDIS_PORT SOAK_SMTP_PORT SOAK_SMTP_HTTP_PORT SOAK_CRM_PORT
export SOAK_API_PORT="${SOAK_API_PORT:-3211}"
export SOAK_ORIGIN="http://localhost:5173"
export SOAK_BASE_URL="http://127.0.0.1:${SOAK_API_PORT}"
export SOAK_SMTP_API="http://127.0.0.1:${SOAK_SMTP_HTTP_PORT}"

# SOAK_NODE_ENV=test lifts the per-minute rate limits (load phases); development keeps them.
export NODE_ENV="${SOAK_NODE_ENV:-test}"
export PORT="${PORT:-$SOAK_API_PORT}"
export DATABASE_URL="postgresql://amqur_test:amqur_test_pw@127.0.0.1:${SOAK_PG_PORT}/amqur_test?schema=public"
export REDIS_URL="redis://127.0.0.1:${SOAK_REDIS_PORT}"
export JWT_SECRET='test-jwt-secret-at-least-32-characters-long!!'
export JWT_EXPIRES_IN=15m JWT_REFRESH_EXPIRES_IN=7d WIDGET_TOKEN_EXPIRES_IN=4h
export CORS_ORIGINS="${SOAK_ORIGIN},http://127.0.0.1:5173"
export BOOTSTRAP_SECRET='test-bootstrap-secret-16+'
export CRM_WEBHOOK_URL="http://127.0.0.1:${SOAK_CRM_PORT}/"
export INVENTORY_SYNC_ENABLED=false
export INTEGRATION_ENCRYPTION_KEY='test-integration-encryption-key-32b'
export OUTBOX_PROCESSOR_ENABLED="${OUTBOX_PROCESSOR_ENABLED:-true}"
export PROCESS_ROLE="${PROCESS_ROLE:-all}"
export CANARY_EMPLOYEE_ENABLED=false
export ANTHROPIC_API_KEY='' OPENAI_API_KEY=''
export ADF_SEND_ENABLED=true LEAD_DELIVERY_MODE=sandbox ADF_SANDBOX_TRANSPORT=smtp
export ADF_SMTP_HOST=127.0.0.1 ADF_SMTP_PORT="${SOAK_SMTP_PORT}"
export ADF_FROM_ADDRESS='adf-sandbox@amqur.example.invalid'
export SANDBOX_SCHEDULER_ENABLED=true

case "$DATABASE_URL" in
  *"@127.0.0.1:${SOAK_PG_PORT}/"*) ;;
  *) echo "soak-env: refusing — DATABASE_URL is not the soak Postgres on 127.0.0.1:${SOAK_PG_PORT}" >&2; exit 1 ;;
esac
case "$SOAK_PG_PORT:$SOAK_REDIS_PORT:$SOAK_API_PORT" in
  55432:*|*:56379:*|*:3001|*:3111) echo "soak-env: refusing — port collides with the shared test/demo stack" >&2; exit 1 ;;
esac
case "$NODE_ENV" in test|development) ;; *) echo "soak-env: refusing — NODE_ENV must be test or development" >&2; exit 1 ;; esac

if [ "${BASH_SOURCE[0]}" = "$0" ] && [ "$#" -gt 0 ]; then exec "$@"; fi
