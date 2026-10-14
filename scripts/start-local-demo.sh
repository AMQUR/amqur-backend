#!/usr/bin/env bash
# Local owner demo API on :3001 against the DISPOSABLE test stack (docker-compose.test.yml).
# Never points at Railway: refuses any non-local DATABASE_URL.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./test-infra/.env.test; set +a
DB_HOST="$(node -e "console.log(new URL(process.env.DATABASE_URL).hostname)")"
case "$DB_HOST" in localhost|127.0.0.1) ;; *) echo "Refusing: non-local DATABASE_URL host $DB_HOST" >&2; exit 1;; esac
export NODE_ENV=development PORT="${PORT:-3001}"
export CORS_ORIGINS="http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173,http://localhost:3001,http://127.0.0.1:18084,http://localhost:18084"
# AI: set ANTHROPIC_API_KEY in your own shell (never in a file in Git) to enable LLM polish.
# Without it the concierge runs fully deterministic.
if [ -n "${AMQUR_DEMO_ANTHROPIC_API_KEY:-}" ]; then export ANTHROPIC_API_KEY="$AMQUR_DEMO_ANTHROPIC_API_KEY"; fi
node -e "console.log('[demo] LLM provider: anthropic=' + (process.env.ANTHROPIC_API_KEY ? 'configured' : 'missing') + ' openai=' + (process.env.OPENAI_API_KEY ? 'configured' : 'missing') + ' model=' + (process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5 (default)'))"
npx prisma migrate deploy >/dev/null
[ -f dist/main.js ] && [ "${SKIP_BUILD:-0}" = 1 ] || npx nest build
exec node dist/main.js
