#!/usr/bin/env bash
# Dry-run then apply six fail-closed production tenants via DATABASE_URL.
# Intended to run with Railway-injected production DATABASE_URL:
#
#   railway run --service prod-api --environment production -- \
#     ./scripts/onboard-production-tenants.sh [--apply]
#
# Default is dry-run only (prints would-be results; CLI script commits unless
# we use a dedicated dry path — this wrapper validates JSON then applies
# only with --apply).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CFG_DIR="${ROOT}/config/production-onboarding"
APPLY=0
for a in "$@"; do
  [ "$a" = "--apply" ] && APPLY=1
done

[ -n "${DATABASE_URL:-}" ] || { echo "DATABASE_URL required (use railway run)" >&2; exit 1; }

TENANTS=(
  dial-auto-group
  jeep-of-chicago
  dial-nissan-of-chicago
  dial-chevy-of-chicago
  infiniti-of-chicago
  dial-cdjr-of-chicago
)

echo "== Validate production onboarding JSON =="
for t in "${TENANTS[@]}"; do
  f="${CFG_DIR}/${t}.json"
  [ -f "$f" ] || { echo "missing $f" >&2; exit 1; }
  node -e '
const fs=require("fs");
const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
if (!Array.isArray(c.allowedOrigins) || c.allowedOrigins.length!==0) {
  console.error("allowedOrigins must be []"); process.exit(1);
}
const f=c.featureFlags||{};
for (const k of ["inventory","payments","serviceAi","partsAi","appointments","voiceAi","multilingual","proactiveEngagement"]) {
  if (f[k]) { console.error("feature must be false:", k); process.exit(1); }
}
for (const k of ["chat","leadCapture","handoff"]) {
  if (!f[k]) { console.error("feature must be true:", k); process.exit(1); }
}
for (const banned of ["address","phone","storeHours","inventoryFeedUrl","escalationRecipients","adminUser"]) {
  if (c[banned]!=null) { console.error("must omit guessed field:", banned); process.exit(1); }
}
const b=c.branding||{};
for (const banned of ["privacyUrl","termsUrl","websiteUrl","phone"]) {
  if (b[banned]!=null) { console.error("must omit guessed branding:", banned); process.exit(1); }
}
// Verified brand assets may set colors + CDN logo URLs only.
for (const k of ["primaryColor","accentColor","logoUrl","logoAlt"]) {
  if (b[k]==null) continue;
  if (typeof b[k] !== "string" || !b[k].trim()) {
    console.error("branding."+k+" must be a non-empty string when set"); process.exit(1);
  }
}
if (b.logoUrl!=null) {
  try {
    const u=new URL(b.logoUrl);
    if (u.protocol!=="https:" || u.hostname!=="widget.dialusnow.com") {
      console.error("logoUrl must be https://widget.dialusnow.com/..."); process.exit(1);
    }
    if (!u.pathname.startsWith("/assets/tenants/")) {
      console.error("logoUrl path must be under /assets/tenants/"); process.exit(1);
    }
  } catch {
    console.error("logoUrl must be absolute URL"); process.exit(1);
  }
}
if (b.primaryColor!=null && !/^#[0-9A-Fa-f]{6}$/.test(b.primaryColor)) {
  console.error("primaryColor must be #RRGGBB"); process.exit(1);
}
if (b.accentColor!=null && !/^#[0-9A-Fa-f]{6}$/.test(b.accentColor)) {
  console.error("accentColor must be #RRGGBB"); process.exit(1);
}
if (/staging/i.test(JSON.stringify(c))) { console.error("staging leak in config"); process.exit(1); }
console.log("OK", c.tenantSlug);
' "$f"
done

if [ "${APPLY}" != "1" ]; then
  echo
  echo "Dry validation passed. Re-run with --apply to persist (via railway run)."
  exit 0
fi

echo "== Apply production onboarding =="
for t in "${TENANTS[@]}"; do
  echo "--> ${t}"
  npx --yes ts-node --transpile-only "${ROOT}/scripts/onboard-dealership.ts" \
    --config "${CFG_DIR}/${t}.json"
done

echo "Done. Verify public configs and empty-origin token 403s next."
