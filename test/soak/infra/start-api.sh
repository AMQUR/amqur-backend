#!/usr/bin/env bash
# Start one API process (or, with SOAK_ENTRY=dist/worker.js, one outbox worker) of the soak stack
# in the background.
#   bash test/soak/infra/start-api.sh [port] [name]
# Env: SOAK_NODE_ENV (test|development), SOAK_NODE_FLAGS (e.g. "--inspect=127.0.0.1:9311 --expose-gc"),
#      SOAK_ENTRY (dist/main.js), OUTBOX_PROCESSOR_ENABLED, OUTBOX_POLL_MS (worker), CHAT_STREAM_HEARTBEAT_MS.
# Writes <SOAK_OUT>/<name>.pid and <SOAK_OUT>/logs/<name>.log. Requires a prior `npm run build`.
set -euo pipefail
cd "$(dirname "$0")/../../.."
PORT_ARG="${1:-3211}"; NAME="${2:-api-$PORT_ARG}"
: "${SOAK_OUT:?set SOAK_OUT to a scratch directory outside the repository}"
mkdir -p "$SOAK_OUT/logs"
export PORT="$PORT_ARG" SOAK_API_PORT="${SOAK_API_PORT:-$PORT_ARG}"
. test/soak/infra/soak-env.sh
ENTRY="${SOAK_ENTRY:-dist/main.js}"
[ -f "$ENTRY" ] || { echo "$ENTRY missing — run npm run build" >&2; exit 1; }
nohup node ${SOAK_NODE_FLAGS:-} "$ENTRY" >>"$SOAK_OUT/logs/$NAME.log" 2>&1 &
echo $! >"$SOAK_OUT/$NAME.pid"
echo "started $NAME pid=$(cat "$SOAK_OUT/$NAME.pid") port=$PORT NODE_ENV=$NODE_ENV entry=$ENTRY"
