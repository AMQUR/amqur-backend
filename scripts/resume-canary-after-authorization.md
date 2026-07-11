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

## 1. Verify provider authentication (approved paths only)

### Unsupported — do not use

- Stock Cloud SDK OAuth client + Tag Manager scopes (`gcloud auth application-default login` / `gcloud auth login` requesting `tagmanager.*` via the default Cloud SDK client)
- Google blocks that client for sensitive Tag Manager scopes (“This app is blocked”)
- That path is **unsupported** for AMQUR GTM deployment

### Path A — Direct Tag Manager web (preferred for operators)

1. Sign in at [tagmanager.google.com](https://tagmanager.google.com) with an account authorized for Jeep of Chicago  
2. Confirm container access (observed public ID `GTM-MP5XGBXQ` is discovery only — verify ownership)  
3. Confirm **Read + Edit** (Approve optional; Publish not required for this runbook)  
4. Do not paste passwords, cookies, or tokens into chat or Git  

### Path B — Organization-controlled OAuth client

See `docs/integrations/GTM_ORG_OAUTH_CLIENT_REQUIREMENTS.md`.  
Use only an AMQUR / dealership-owned OAuth client approved for Tag Manager read/edit. Store secrets in Railway / Keychain.

### Path C — TeamVelocity / Apollo

Confirm authenticated support portal or CSM channel for Jeep of Chicago only.  
Use `amqur-widget/docs/deployment/jeep-of-chicago-teamvelocity-request.md`.  
Do not invent contacts or APIs.

## 2. Verify human-handoff routing

- Approved test destination configured (e.g. Railway `CRM_WEBHOOK_URL` pointing at a **test** inbox)
- Send one approved test escalation
- Confirm receipt and failure path

## 3. Inventory gate

- If live vAuto is **not** connected: keep `inventory` / compare / saved / finance calculator **false** for public customer mode
- Never point production hostname at fixture inventory

## 4. Create unpublished / employee-only canary

1. Open GTM — create workspace **AMQUR Internal Employee Canary** (do not edit the live/default workspace for AMQUR tags)  
2. Install **Level 1** snippet only (`amqur-widget/docs/deployment/snippets/level1-employee.html`) + hosted `amqur-canary-loader.js`  
3. Set `apiBaseUrl` / `assetUrl` to provisioned **HTTPS** production hosts (refuse localhost)  
4. Trigger: hostname allowlist + employee gate (Preview / secure cookie — not a permanent plaintext password)  
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

- End Preview / disable AMQUR tags in the unpublished workspace **or** pause TeamVelocity script entry  
- Set location `featureFlags.chat=false`  
- Revert CDN pin if needed  

## Automation helper

```bash
./scripts/resume-canary-gate-check.sh
```

Exits non-zero if canary config still blocks public inventory incorrectly, or if required docs are missing.
