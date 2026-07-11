#!/usr/bin/env bash
# Provision AMQUR staging-only Railway project and services.
# Requires: authenticated railway CLI in PATH.
# Does NOT touch production projects.
set -euo pipefail

export PATH="${HOME}/.local/bin:${PATH}"

PROJECT_NAME="amqur-platform-staging"
BACKEND_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="${BACKEND_DIR}/.railway-staging"
mkdir -p "${STATE_DIR}"

if ! railway whoami >/dev/null 2>&1; then
  echo "ERROR: railway not authenticated. Run: railway login" >&2
  exit 1
fi

echo "==> Authenticated as: $(railway whoami 2>/dev/null | head -1)"

# List projects (JSON if supported)
LIST_JSON=$(railway list --json 2>/dev/null || true)
EXISTING=""
if [[ -n "${LIST_JSON}" ]]; then
  EXISTING=$(node -e "
    const raw=process.argv[1];
    try {
      const data=JSON.parse(raw);
      const arr=Array.isArray(data)?data:(data.projects||data||[]);
      const hit=arr.find(p => String(p.name||'').toLowerCase()==='amqur-platform-staging'
        || (String(p.name||'').toLowerCase().includes('amqur') && String(p.name||'').toLowerCase().includes('staging')));
      if (hit) console.log(hit.id||hit.projectId||hit.name);
    } catch {}
  " "${LIST_JSON}" || true)
fi

if [[ -z "${EXISTING}" ]]; then
  echo "==> Creating Railway project ${PROJECT_NAME}"
  # Non-interactive init
  cd "${BACKEND_DIR}"
  railway init --name "${PROJECT_NAME}" --yes 2>&1 | tee "${STATE_DIR}/init.log" || {
    # Fallback if flags differ
    railway init -n "${PROJECT_NAME}" 2>&1 | tee "${STATE_DIR}/init.log"
  }
else
  echo "==> Found existing staging project id/name: ${EXISTING}"
  cd "${BACKEND_DIR}"
  railway link --project "${EXISTING}" --yes 2>&1 | tee "${STATE_DIR}/link.log" || \
    railway link 2>&1 | tee "${STATE_DIR}/link.log"
fi

echo "==> Project status"
railway status --json 2>${STATE_DIR}/status.json || railway status | tee "${STATE_DIR}/status.txt"

echo "==> Adding postgres-staging (if missing)"
railway add --database postgres --json 2>&1 | tee "${STATE_DIR}/add-postgres.log" || true

echo "==> Adding redis-staging (if missing)"
railway add --database redis --json 2>&1 | tee "${STATE_DIR}/add-redis.log" || true

echo "==> Adding backend-staging empty service (if missing)"
railway add --service backend-staging --json 2>&1 | tee "${STATE_DIR}/add-backend.log" || true

echo "==> Adding widget-staging empty service (if missing)"
railway add --service widget-staging --json 2>&1 | tee "${STATE_DIR}/add-widget.log" || true

echo "Provision script finished. Inspect ${STATE_DIR} logs."
