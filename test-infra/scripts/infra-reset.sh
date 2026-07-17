#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
"$ROOT/test-infra/scripts/infra-down.sh"
"$ROOT/test-infra/scripts/infra-up.sh"
export DATABASE_URL="${DATABASE_URL:-postgresql://amqur_test:amqur_test_pw@127.0.0.1:55432/amqur_test?schema=public}"
npx prisma migrate deploy
npx prisma generate
echo "[amqur-test] Reset + migrate deploy complete."
