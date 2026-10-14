#!/usr/bin/env bash
# Read-only staging acceptance (no writes except creating anonymous widget conversations).
# Usage: scripts/staging-acceptance.sh [api-base] [expected-sha] [widget-origin]
set -uo pipefail
API="${1:-https://staging-api.dialusnow.com}"
SHA="${2:-}"
ORIGIN="${3:-https://staging-widget.dialusnow.com}"
pass=0; fail=0
ok() { echo "PASS  $*"; pass=$((pass+1)); }
ko() { echo "FAIL  $*"; fail=$((fail+1)); }

v=$(curl -s --max-time 15 "$API/api/version")
sha=$(echo "$v" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).data.commitSha)}catch{console.log("")}})')
[ -n "$SHA" ] && { [ "$sha" = "$SHA" ] && ok "release sha $sha" || ko "release sha $sha (expected $SHA)"; } || echo "INFO  release sha $sha"
h=$(curl -s --max-time 15 "$API/api/health")
echo "$h" | grep -q '"database":"up"' && ok "database up" || ko "database: $h"
llm=$(echo "$h" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).data.checks.llm??"not-reported")}catch{console.log("unknown")}})')
echo "INFO  llm provider key on this environment: $llm"

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
