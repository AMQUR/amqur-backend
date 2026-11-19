#!/usr/bin/env bash
# Soak stack lifecycle. Touches ONLY the `amqur-soak` compose project and processes it started.
#   bash test/soak/infra/stack.sh up      # containers + migrate + seed (five rooftops, group site, local demo)
#   bash test/soak/infra/stack.sh reset   # down (drops the volume) + up
#   bash test/soak/infra/stack.sh stop-apis
#   bash test/soak/infra/stack.sh down    # stop APIs started by start-api.sh, remove containers + volume
set -euo pipefail
cd "$(dirname "$0")/../../.."
ROOT="$(pwd)"
COMPOSE=(docker compose -p amqur-soak --project-directory "$ROOT" -f "$ROOT/test/soak/infra/compose.soak.yml")

stop_apis() {
  [ -n "${SOAK_OUT:-}" ] || return 0
  for f in "$SOAK_OUT"/*.pid; do
    [ -f "$f" ] || continue
    pid="$(cat "$f")"
    # Only a node process running this build's entry points is ours to stop.
    if ps -p "$pid" -o command= 2>/dev/null | grep -Eq 'dist/(main|worker)\.js'; then kill "$pid" 2>/dev/null || true; fi
    rm -f "$f"
  done
}

case "${1:-}" in
  up)
    "${COMPOSE[@]}" up -d --wait
    . test/soak/infra/soak-env.sh
    npx prisma migrate deploy >/dev/null
    npm run -s seed:local-demo >/dev/null
    npm run -s seed:local-demo:lead-route >/dev/null
    npm run -s seed:group-rooftops >/dev/null
    echo "soak stack up: postgres :$SOAK_PG_PORT redis :$SOAK_REDIS_PORT mock-smtp :$SOAK_SMTP_PORT/:$SOAK_SMTP_HTTP_PORT mock-crm :$SOAK_CRM_PORT (seeded)"
    ;;
  stop-apis) stop_apis ;;
  down)
    stop_apis
    "${COMPOSE[@]}" down -v
    ;;
  reset)
    stop_apis
    "${COMPOSE[@]}" down -v
    exec bash "$0" up
    ;;
  *) echo "usage: stack.sh up|reset|stop-apis|down" >&2; exit 2 ;;
esac
