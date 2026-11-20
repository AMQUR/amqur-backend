#!/usr/bin/env bash
# Local owner demo API on :3001 against the DISPOSABLE test stack (docker-compose.test.yml).
# Never points at Railway: refuses any non-local DATABASE_URL.
set -euo pipefail
cd "$(dirname "$0")/.."
CALLER_PORT="${PORT:-}"
set -a; . ./test-infra/.env.test; set +a
DB_HOST="$(node -e "console.log(new URL(process.env.DATABASE_URL).hostname)")"
case "$DB_HOST" in localhost|127.0.0.1) ;; *) echo "Refusing: non-local DATABASE_URL host $DB_HOST" >&2; exit 1;; esac
# DEMO_NODE_ENV=test lifts the per-minute rate limit for automated browser runs against this
# local stack (several journeys in one minute). Only development or test; never production.
case "${DEMO_NODE_ENV:-development}" in development|test) ;; *) echo "Refusing: DEMO_NODE_ENV must be development or test" >&2; exit 1;; esac
export NODE_ENV="${DEMO_NODE_ENV:-development}" PORT="${CALLER_PORT:-3001}"
# .env.test points CRM_WEBHOOK_URL at the mock-CRM test double. Its 200 is not a person being
# alerted, so the demo must not say "I've alerted the team". Use a real receiver only if given.
export CRM_WEBHOOK_URL="${DEMO_CRM_WEBHOOK_URL:-}"
export CORS_ORIGINS="http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173,http://localhost:3001,http://127.0.0.1:18084,http://localhost:18084"
# Lead delivery in the demo: sandbox only. NODE_ENV=development forces the sandbox transport, the
# SMTP host must be loopback and the recipient a reserved example.invalid address, so nothing can
# reach a real mailbox. A delivery happens only if the demo rooftop also has the adfLeadDelivery
# flag and a SANDBOX route (npm run seed:local-demo:lead-route); otherwise it is recorded BLOCKED.
export ADF_SEND_ENABLED="${DEMO_ADF_SEND_ENABLED:-true}" LEAD_DELIVERY_MODE=sandbox ADF_SANDBOX_TRANSPORT="${DEMO_ADF_SANDBOX_TRANSPORT:-smtp}"
# Sandbox (demo) scheduler: explicit opt-in (default off everywhere else; refused in production).
export SANDBOX_SCHEDULER_ENABLED="${DEMO_SANDBOX_SCHEDULER_ENABLED:-true}"
# AI: set ANTHROPIC_API_KEY in your own shell (never in a file in Git) to enable LLM polish.
# Without it the concierge runs fully deterministic.
if [ -n "${AMQUR_DEMO_ANTHROPIC_API_KEY:-}" ]; then export ANTHROPIC_API_KEY="$AMQUR_DEMO_ANTHROPIC_API_KEY"; fi
node -e "console.log('[demo] LLM provider: anthropic=' + (process.env.ANTHROPIC_API_KEY ? 'configured' : 'missing') + ' openai=' + (process.env.OPENAI_API_KEY ? 'configured' : 'missing') + ' model=' + (process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5 (default)'))"
npx prisma migrate deploy >/dev/null
[ -f dist/main.js ] && [ "${SKIP_BUILD:-0}" = 1 ] || npx nest build
exec node dist/main.js
