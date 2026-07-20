# Dial Auto Group — production onboarding (group tenant)

**Tenant slug:** `dial-auto-group`  
**Config:** `config/production-onboarding/dial-auto-group.json`  
**Docs mirror:** `docs/onboarding/tenants/dial-auto-group.production.json`

## Deferred fields (apply in a later pass)

Do not guess these in production JSON until verified:

- `phone`, `address`, `storeHours`
- `branding.primaryColor`, `branding.accentColor`, `branding.logoUrl`

## Store preference

No dedicated feature flag exists (`storePreference`, `preferredStore`, and `preferredDealership` are not in the schema). Capture preferred dealership via `branding.welcomeMessage`, `branding.disclaimerText`, and `branding.escalationMessage` only.

## Dry-run paths

### 1. Shell wrapper (JSON validation only — no DB writes)

Validates all six production onboarding files, including fail-closed flags and omitted guessed fields:

```bash
cd backend
railway run --service prod-api --environment production -- \
  ./scripts/onboard-production-tenants.sh
```

Re-run with `--apply` only after validation passes and ops approval is recorded.

### 2. Onboarding API (transaction rolled back)

`POST /api/onboarding/dealership` (SUPER_ADMIN). Set `"dryRun": true` on the request body; the service runs the full validated onboarding inside a transaction and rolls it back.

```bash
curl -sS -X POST "${API_BASE}/onboarding/dealership" \
  -H "Authorization: Bearer ${SUPER_ADMIN_JWT}" \
  -H "Content-Type: application/json" \
  --data-binary "$(jq '. + {dryRun: true, idempotent: true}' config/production-onboarding/dial-auto-group.json)"
```

Or merge `dryRun: true` into the JSON payload manually before posting.

### 3. CLI script (no dry-run — persists)

`scripts/onboard-dealership.ts` always writes when `DATABASE_URL` is set. Use only with `--apply` via the shell wrapper or an explicit ops run:

```bash
railway run --service prod-api --environment production -- \
  npx ts-node --transpile-only scripts/onboard-dealership.ts \
  --config config/production-onboarding/dial-auto-group.json
```

## Feature flag key set

Production onboarding JSON uses the same eleven keys as the five rooftop configs. Platform defaults cover additional flags (e.g. `crossStoreInventory`, `automatedFollowup`) without listing them here.

Flags **not** in the platform schema and omitted from config: `smsDelivery`, `emailDelivery`, `crmDelivery`, `automatedFollowUp` (use `automatedFollowup` if ever needed explicitly).
