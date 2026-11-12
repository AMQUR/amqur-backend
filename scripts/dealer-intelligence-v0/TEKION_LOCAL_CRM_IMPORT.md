# Private Tekion lead export → AMQUR aggregate importer

This is a **local-only, read-only** bridge for the free Dial Auto Group flagship. It takes the five authorized Tekion `CRM LEAD LIST` exports (one per rooftop) and creates PII-free daily purchase-lead cohorts compatible with `scorecard.mjs`. It does **not** connect to an undocumented Tekion API or perform customer outreach.

## Run (Node.js 22+)

Place **exactly five** authorized `_CRM_LEAD_LIST_*.csv` exports into a private directory outside Git. Do not copy these exports into the AMQUR public repository. Give the output directory a similarly private location.

```bash
node scripts/dealer-intelligence-v0/tekion-export-to-aggregates.mjs \
  --input /path/to/private/tekion-exports \
  --out /path/to/private/aggregated-report-input
```

Outputs `crm.csv` and `crm_aggregate_quality.json`; no individual customer rows are emitted. Source CSVs may contain names, phones, emails, notes, loan-related fields and VINs; keep them access-restricted and delete per the approved retention policy.

The importer requires each CSV to contain `Dealership`, `Creation Time`, `Status`, `Department`, `Sales Lead Type`, `Stock Type`. It accepts only the five mapped store aliases from the existing account configuration, rejects unknown aliases, duplicate store files and unexpected statuses. Store assignments, particularly North versus South CDJR, must be verified against Tekion store IDs before automated reconciliation.

## Metric definition

- **Lead counts**: individual CRM records where Department=Sales, Sales Lead Type=`VEHICLE_PURCHASE`, Status not `Duplicate` or `Bad`.
- **Date**: Creation Time date printed by Tekion; confirm store/export time zone before cross-platform attribution.
- **Business line**: Stock Type `New`, `Used` or `unclassified` (blanks and unknown values are never guessed).
- **Appointments / shows / sold**: intentionally blank, meaning unknown. Current CRM Stage or a nonblank Sold Date do **not** prove appointment events or posted DMS sale.
- **Coverage**: emits every day with at least one eligible purchase lead, and its three business-line subtotals; absent dates are unknown, not invented zeros. For the user-provided Sep–Nov exports, all 62 days are represented for all five stores.

Run tests:

```bash
node --test scripts/dealer-intelligence-v0/tekion-export-to-aggregates.test.mjs
```

Do not upload raw exports to GitHub, commit report outputs, activate live API integrations or make CRM/marketing modifications as part of this importer. To validate true vehicle sales, obtain an authorized, de-identified Tekion DMS sold ledger keyed by store/date/transaction status, including unwinds and rebooks.
