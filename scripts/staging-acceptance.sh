#!/usr/bin/env bash
# Read-only staging acceptance (no writes except creating anonymous widget conversations).
# Usage: scripts/staging-acceptance.sh <api-base> <expected-sha> [widget-origin]
#
# Acceptance of a release requires the EXPECTED SHA (the merge commit that the Deploy run
# built). Without it — or if the deployed SHA differs — the run fails: a green run against an
# older build (e.g. the August 63425e0) proves nothing about the new release. The
# "release markers" below only exist in the October 2026 build, so an old build fails them
# even if someone passes its own SHA.
set -uo pipefail
API="${1:-https://staging-api.dialusnow.com}"
SHA="${2:-}"
ORIGIN="${3:-https://staging-widget.dialusnow.com}"
pass=0; fail=0
ok() { echo "PASS  $*"; pass=$((pass+1)); }
ko() { echo "FAIL  $*"; fail=$((fail+1)); }
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);console.log(eval(process.argv[1])??"")}catch{console.log("")}})' "$1"; }

v=$(curl -s --max-time 15 "$API/api/version")
sha=$(echo "$v" | json 'o.data.commitSha')
if [ -z "$SHA" ]; then
  ko "no expected SHA given — cannot prove which build is deployed (deployed: ${sha:-unknown})"
elif [ "$sha" = "$SHA" ] || { [ ${#SHA} -lt 40 ] && [ "${sha#"$SHA"}" != "$sha" ]; }; then
  ok "deployed sha $sha matches expected $SHA"
else
  ko "deployed sha ${sha:-unknown} != expected $SHA (new build not deployed, or deploy still rolling)"
fi
h=$(curl -s --max-time 15 "$API/api/health")
echo "$h" | grep -q '"database":"up"' && ok "database up" || ko "database: $h"
llm=$(echo "$h" | json 'o.data.checks.llm')
[ -n "$llm" ] && ok "release marker: health reports checks.llm ($llm)" || ko "release marker: health has no checks.llm — pre-October build"
sp=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$API/api/public/spotlights?tenantSlug=jeep-of-chicago&locationSlug=main")
[ "$sp" = "200" ] && ok "release marker: /api/public/spotlights" || ko "release marker: /api/public/spotlights → $sp"
ai=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$API/api/ops/ai/status")
[ "$ai" = "401" ] && ok "release marker: /api/ops/ai/status exists and requires auth" || ko "release marker: /api/ops/ai/status → $ai (expected 401)"
[ "$llm" = "configured" ] && echo "INFO  llm provider key present on this environment" || echo "INFO  llm provider key NOT configured — real-AI checks (npm run ai:check / eval:live-model) cannot run yet"

for t in jeep-of-chicago dial-nissan-of-chicago dial-chevy-of-chicago infiniti-of-chicago dial-cdjr-of-chicago; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$API/api/public/widget-config?tenantSlug=$t&locationSlug=main")
  [ "$code" = "200" ] && ok "widget-config $t" || ko "widget-config $t → $code"
  bad=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST "$API/api/public/widget-token" -H 'Origin: https://unauthorized.example' -H 'Content-Type: application/json' -d "{\"tenantSlug\":\"$t\",\"locationSlug\":\"main\"}")
  [ "$bad" = "403" ] && ok "unauthorized origin refused for $t" || ko "unauthorized origin for $t → $bad"
  tok=$(curl -s --max-time 15 -X POST "$API/api/public/widget-token" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -d "{\"tenantSlug\":\"$t\",\"locationSlug\":\"main\"}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).data.token||"")}catch{console.log("")}})')
  if [ -z "$tok" ]; then echo "INFO  $t: staging widget origin $ORIGIN not allowed — chat checks skipped"; continue; fi
  r=$(curl -s --max-time 30 -X POST "$API/api/chat" -H "Origin: $ORIGIN" -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' -d '{"message":"What vehicles do you have in stock?"}')
  echo "$r" | grep -q '"simulated":true' && ko "$t serves SIMULATED vehicles" || ok "$t serves no simulated vehicles"
  echo "$r" | grep -q 'tekioncloud\|token=' && ko "$t leaks a credit destination" || ok "$t leaks no credit destination"
done
echo "SUMMARY pass=$pass fail=$fail"
[ "$fail" = 0 ]
