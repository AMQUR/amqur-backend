# Resume canary after external authorization

Use this runbook only after GTM/TeamVelocity access, handoff routing, and (if needed) production hosts exist.  
**Stops before publish.** Does not enable Tekion/vAuto or customer traffic by itself.

## 0. Preconditions checklist

```bash
# From backend repo
test -f docs/EXTERNAL_AUTHORIZATION_REQUIRED.md
test -f config/canary-jeep-of-chicago.json
# Public inventory must still be false in canary config
python3 -c "import json;c=json.load(open('config/canary-jeep-of-chicago.json'));assert c['featureFlags']['publicCustomerMode']['inventory'] is False"
```

## 1. Verify provider authentication

```bash
# Prefer gcloud / GTM API when installed and authorized
command -v gcloud >/dev/null && gcloud auth list
# Or confirm TeamVelocity portal session for Jeep of Chicago only
# Do not paste tokens into chat or Git
```

Confirm the authenticated account can access the correct Jeep of Chicago GTM container (public ID observed: `GTM-MP5XGBXQ` — verify ownership).

## 2. Verify human-handoff routing

- Approved test destination configured (e.g. Railway `CRM_WEBHOOK_URL` pointing at a **test** inbox)
- Send one approved test escalation
- Confirm receipt and failure path

## 3. Inventory gate

- If live vAuto is **not** connected: keep `inventory` / compare / saved / finance calculator **false** for public customer mode
- Never point production hostname at fixture inventory

## 4. Create unpublished / employee-only canary

1. Open GTM workspace (unpublished)  
2. Install **Level 1** snippet only (`amqur-widget/docs/deployment/snippets/level1-employee.html`) + hosted `amqur-canary-loader.js`  
3. Set `apiBaseUrl` / `assetUrl` to provisioned **HTTPS** production hosts (refuse localhost)  
4. Trigger: hostname allowlist + employee cookie/query gate  
5. Use GTM **Preview** — do not publish  

## 5. Preview tests

- Wrong host → no init  
- Without employee gate → no widget asset  
- With employee gate → bootstrap + token Origin scoped  
- Kill switch `?amqur_canary_kill=1` tears down  
- Duplicate GTM fire → single init  
- Unsupported claims / inventory disabled  

## 6. Stop before publish

Do **not** publish the container. Capture preview evidence. Request **final explicit publish authorization** from the named business owner.

## 7. Immediate rollback

- Publish Level 0 / prior container version **or** pause AMQUR tags  
- Set location `featureFlags.chat=false`  
- Revert CDN pin if needed  

## Automation helper

```bash
./scripts/resume-canary-gate-check.sh
```

Exits non-zero if canary config still blocks public inventory incorrectly, or if required docs are missing.
