# AMQUR Dealer Intelligence — private, authenticated group reporting

**Engagement:** Dial Auto Group (family-affiliated); **price: $0**; no future fee implied.  
**Scope:** Five distinct Chicago rooftops and the separate central/group Google Ads account.  
**State:** Code-review and staging-candidate only. **No public website installation or production activation.**

## Architecture

The existing Node.js 22 aggregate pipeline produces `aggregate-report.json` from:

- Authorized PII-free Google Ads daily account aggregates; Meta, Microsoft, GA4 and call channels are still **missing**.
- Authorized Tekion CRM Lead List, reduced locally to store/day/business-line eligible purchase leads (not unique persons).
- Authorized Tekion Deal List, reduced locally to **provisional retail-like candidates**, not confirmed deliveries/posted accounting results.

The private builder and refresh runner never write CRM/DMS individual records to GitHub or serve embedded HTML publicly. The refreshed aggregate JSON, owner brief, and source-hash manifest live in an access-controlled private directory **outside the repository and public web root**.

The NestJS API reads the approved aggregate file only when explicitly enabled and exposes a **GET-only** route:

- `GET /api/ops/dealer-intelligence/snapshot`
- Existing JWT auth and MFA enforcement apply; `@Roles('SUPER_ADMIN')` provides additional group-wide access control.
- No raw filenames, arbitrary paths, account credentials, writeback calls, CORS exceptions, or public APIs.
- Snapshot projection denies unexpected fields, duplicate rows, unknown stores, impossible dates/numbers, misreported source coverage, unreconciled totals, synthetic flags, PII-like text, and pre-approved actions.
- Responses use `Cache-Control: private, no-store`, noindex, and deny caching.
- Any missing/misconfigured/unsafe file returns 503 without exposing local paths or JSON content.
- The endpoint is disabled by default; frontend nav is only visible to SUPER_ADMIN.

## Safe private refresh

Use an authorized computer or task runner with Node.js 22 and verified file ownership. Raw exports remain **outside Git**.

```bash
node --experimental-strip-types scripts/dealer-intelligence-v0/refresh-private.mjs \
  --ads /secure/input/aggregate-ads.csv \
  --crm-input /secure/input/five-crm-csv-files \
  --dms-manifest /secure/input/deal-export-manifest.json \
  --private-root /secure/amqur/dial-intelligence \
  --as-of YYYY-MM-DD
```

If CRM/DMS files are already approved PII-free aggregates, use `--crm-aggregate` and `--dms-aggregate` instead. The runner requires exactly one source mode for each. Every execution:

1. Locks the private reporting directory to avoid concurrent updates.
2. Validates and reduces the source data only in temporary private directories.
3. Builds the aggregate dashboard, source-hash manifest and owner brief.
4. Re-runs the **same privacy-safe server projection** that the API uses.
5. Atomically updates the private owner brief and provenance manifest, then publishes `aggregate-report.json` **last**.
6. Clears temporary artifacts and the lock, leaving existing published state untouched if validation fails.

The runner never schedules itself and never calls official Tekion APIs (no approved API contract). Do not enable automatic refresh until source exports/connectors and protected storage are operating. For a CI-safe demo, append `--synthetic` with the repo's synthetic aggregate fixtures: **no API snapshot is published**.

## Staging configuration (not activated in this PR)

Set all values only in the private environment configuration; the repository must contain **no real data or secrets**.

```text
DEALER_INTELLIGENCE_ENABLED=false
DEALER_INTELLIGENCE_PRIVATE_ROOT=/secure/amqur/dial-intelligence
DEALER_INTELLIGENCE_REPORT_PATH=/secure/amqur/dial-intelligence/aggregate-report.json
```

Enable the flag **only after** a persistent, least-privilege private volume or equivalent protected storage is mounted read-only in the API service and writable in the authorized refresh worker. The directory must not be symlinked, must be outside `process.cwd()`, and must not have world-access permissions. The aggregate JSON must be non-world-readable (recommended file mode `0600`). Confirm the API and writer run under compatible ownership/permissions. Configure disaster recovery and backup/restore evidence for the storage before promotion; verify alert delivery and audit access.

No real data is bundled in frontend build artifacts. The static prototype HTML generated for a private owner preview must **never** be copied into the public CDN or website CMS.

## Staging acceptance checklist

- [ ] All repository checks and the dedicated Dealer Intelligence tests are green on the exact release SHA
- [ ] User is a verified SUPER_ADMIN with MFA; GET succeeds with exact five-store aggregates
- [ ] Unauthenticated, STAFF, MANAGER and widget tokens cannot access GET (401/403)
- [ ] Feature disabled / absent private file returns 503 with no data leakage
- [ ] File mode, symlink, oversized JSON, PII injection, duplicate aggregate and total-tampering tests reject input
- [ ] Snapshot updates atomically; stale snapshot visibly warns without claiming realtime
- [ ] Desktop/mobile Command Center visual and accessibility smoke are reviewed
- [ ] Backup/restore and alert receipts obtained, release owner signs off
- [ ] Real live vendor connectors and posted-sale/appointment data remain explicitly labelled pending

## Data interpretation rules

Do not calculate cost per delivered vehicle, cross-channel marketing ROI or lead-to-sale conversion rates by dividing Google spend, CRM records and retail candidate counts. Their dates and cohorts do **not** match. Report missing CRM outcomes as `null` (unknown), not zero. Separately display central account spend (never allocate it silently). Action register defaults remain `Needs Review / Implemented: No`, with no editing or publishing controls.

## Current blockers outside code

- Official vendor-authorized Tekion API integration (the current path relies on approved exports).
- Posted/delivered accounting ledger and complete appointment scheduled/show/no-show records.
- Meta, Microsoft Ads, GA4 and call tracking data connectors for an all-channel model.
- Staging/private volume and secrets/access policies, verified persistence/backup restore.
- Monitoring/alert delivery, real staff acceptance, visual browser QA and production release approval.

**Do not merge or deploy this draft on enthusiasm alone.** Verify the complete release gate, not just local or CI unit tests. The dashboard is for internal management and is not a customer-facing dealership AI chatbot.