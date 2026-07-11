#!/usr/bin/env bash
# Gate check before resuming Jeep of Chicago canary after external auth.
# Does not publish GTM or enable Tekion/vAuto.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

fail() { echo "FAIL: $*" >&2; exit 1; }

test -f docs/EXTERNAL_AUTHORIZATION_REQUIRED.md || fail "missing EXTERNAL_AUTHORIZATION_REQUIRED.md"
test -f config/canary-jeep-of-chicago.json || fail "missing canary config"
test -f docs/DIAL_AUTO_GROUP_PRODUCTION_ROLLOUT.md || fail "missing rollout report"

python3 - <<'PY'
import json
from pathlib import Path
c=json.loads(Path('config/canary-jeep-of-chicago.json').read_text())
pub=c['featureFlags']['publicCustomerMode']
assert pub.get('inventory') is False, 'public inventory must be disabled without live vAuto'
assert pub.get('tekionIntegration') is False
assert pub.get('vAutoFeed') is False
assert pub.get('automatedFollowup') is False
assert pub.get('voiceAi') is False
assert c.get('websiteInstallation',{}).get('installAuthorized') is False
assert c.get('releaseLevel',0)==0 or c.get('status')=='PREPARED_NOT_INSTALLED'
assert c['origins']['api']['value'] is None
assert c['humanHandoff']['destinationVerified'] is False
print('canary safety gates OK (still not authorized to publish)')
PY

echo "Next: complete EXTERNAL_AUTHORIZATION_REQUIRED.md items, then follow resume-canary-after-authorization.md"
echo "STOP: do not publish GTM without explicit final approval"
