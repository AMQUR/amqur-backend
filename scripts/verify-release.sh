#!/usr/bin/env bash
# Smoke-check that a deployed API is running the expected commit.
#
# Usage: scripts/verify-release.sh <base-url> <expected-commit-sha>
# Example: scripts/verify-release.sh https://staging-api.dialusnow.com $(git rev-parse HEAD)
set -euo pipefail

BASE="${1:?base url required}"
EXPECTED="${2:?expected commit sha required}"

for attempt in $(seq 1 30); do
  BODY="$(curl -sf --max-time 10 "${BASE}/api/version" || true)"
  if [ -n "${BODY}" ]; then
    DEPLOYED="$(node -e "
      let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
        try{const j=JSON.parse(d);const p=j.data??j;console.log(p.commitSha||'unknown')}
        catch{console.log('unparseable')}
      })" <<<"${BODY}")"
    if [ "${DEPLOYED}" = "${EXPECTED}" ]; then
      echo "OK: ${BASE} is running ${EXPECTED}"
      exit 0
    fi
    echo "attempt ${attempt}: deployed=${DEPLOYED} expected=${EXPECTED} — waiting..."
  else
    echo "attempt ${attempt}: /api/version not reachable yet — waiting..."
  fi
  sleep 10
done

echo "FAIL: ${BASE} never reported commit ${EXPECTED}" >&2
exit 1
