#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
docker compose -f docker-compose.test.yml down -v --remove-orphans || true
echo "[amqur-test] Down complete."
