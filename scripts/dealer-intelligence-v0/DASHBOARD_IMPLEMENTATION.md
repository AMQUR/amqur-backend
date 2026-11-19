# AMQUR Dealer Intelligence | internal read-only dashboard

## What is implemented

- **$0 family-affiliated Dial Auto Group flagship:** Five distinct dealerships plus separate central marketing account.
- A static, private, zero-dependency, repeatable reporting workflow running under Node.js 22.
- Ingests only PII-free, store/date/business-line aggregate files from connected Google Ads, the existing authorized Tekion CRM importer, and a **provisional** DMS Deal List importer.
- Builds a self-contained interactive `index.html`, an owner briefing, a normalized JSON report, and a provenance manifest with SHA-256 checksums of aggregate inputs.
- Client-side store/period/new-vs-used filters, daily trend visualization, source coverage, in-context warnings, export of the selected aggregate comparison, and approval-ready action register.
- No employee/customer login needed **only because the output remains private/offline**. **Do not publish HTML to a public host or website without backend authorization and approved data policy.**

## Run a private report

```bash
node --test scripts/dealer-intelligence-v0/*.test.mjs
node scripts/dealer-intelligence-v0/build-dashboard.mjs \
  --ads /path/to/private/aggregate-ads.csv \
  --crm /path/to/private/aggregate-crm.csv \
  --dms /path/to/private/aggregate-dms.csv \
  --out /path/to/private/output-folder \
  --as-of 2026-11-10
```

Open `index.html` locally **from that private output folder**. Store the output on a device or encrypted drive with authorized access; the HTML includes aggregate financial/operational metrics. The inputs must use the exact schemas of `scorecard.mjs` (`ads`,`crm`) and `build-dashboard.mjs` (`dms`). Never point this builder at customer-level Tekion exports.

To prepare an aggregate DMS export from authorized raw Tekion Deal List files **locally**, use:

```bash
node scripts/dealer-intelligence-v0/tekion-deals-to-aggregates.mjs \
  --manifest /path/to/private/dms-manifest.json \
  --out /path/to/private/dms-aggregate \
  --start 2026-08-01 --end 2026-11-10
```

Its output `dms_retail_candidates.csv` exactly matches the dashboard's six-column aggregate contract (`sold_date,store,business_line,retail_candidates,status,source`), including complete zero-count days. Raw exports and the manifest remain outside Git. This importer was checked against all five user-provided DMS exports: **1,020 aggregate rows and 1,053 provisional candidates**, exactly matching the independent prior summary.

To generate a public-safe example, use only `fixtures/synthetic/` and `--synthetic`. The synthetic smoke build in GitHub Actions **never accesses live dealership credentials or data**.

## Current implementation boundaries

- CRM lead records: purchase leads; duplicates, Bad records, and service excluded by existing importer. Not unique households or confirmed qualified inquiries.
- Deal List: retail **candidates** only, not verified posted or delivered units. Gross values are deliberately excluded from public-code dashboard inputs.
- Google Ads: observed aggregate daily spend only; not complete-channel spend. Central group account is not allocated to individual stores.
- DMS event date vs CRM lead date vs Google attribution date **must not** be combined into a cost-per-sold or causal return-on-ad-spend calculation.
- No live APIs, site widgets, database migrations, ad campaign writes, CRM writebacks, consent changes, or production releases.
- The builder refuses report output paths inside this source repository and refuses synthetic fixture inputs without the explicit `--synthetic` flag. Keep output in private encrypted storage.
- Action entries are `Needs Review` and `Implemented=No`. Escalation to live activation requires separate store-specific approvals, vendor contracts, backup/restore, monitoring/alert evidence and per-store tests.

## Future operational integration, not included in this PR

1. Reconcile posted/delivered unit ledger, reversals and matching deal counts.
2. Validate scheduled/shown/no-show/cancelled appointment totals and reporting timestamps.
3. Connect Meta, Microsoft, GA4 and calls using approved, minimum-privilege data extraction.
4. Add tenant-authorized API storage and auditing; serve dashboard behind AMQUR Command Center staff login, not an exposed static web URL.
5. Implement signed refresh jobs with rate limits, secrets in vault and failure alerts, then stage and test a pilot before production activation.

## QA evidence

Node.js 22 regression tests check strict aggregate schemas, PII rejection, tenant mapping, zeros versus unknown, period filters, displayed KPIs, unapproved recommendations, CSV export handler presence and output sanitization. Chromium browser rendering was attempted, but this runtime's administrator policy blocked both local file and loopback page navigation. **Do not claim visual browser QA passed.** Re-run desktop/mobile browser checks in an authorized environment before deployment.