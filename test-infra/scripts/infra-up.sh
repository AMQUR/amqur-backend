#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
echo "[amqur-test] Starting disposable infra…"
docker compose -f docker-compose.test.yml up -d --wait
echo "[amqur-test] Infra up on ports 55432/56379/18081-18084"
