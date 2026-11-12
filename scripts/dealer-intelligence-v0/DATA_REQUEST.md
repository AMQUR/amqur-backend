# Dial data request | 90-day reporting baseline

**No passwords, API secrets, customer data, credit files, complete lead exports or VIN/customer join tables.** The initial audit only needs aggregate daily totals. Save privately and share with approved AMQUR staff; never commit to GitHub.

## Export now from Tekion (first priority)

For each of five stores, export daily aggregate counts for the previous 90 complete calendar days, with the sales business line separated into New and Used where possible:
- Leads received (date of creation); appointments set; appointments shown; sold outcomes.
- Acquisition source / medium at the aggregate level if report supports it.
- Median and 90th-percentile first response time; uncontacted lead count (optional; report separately; do not force into the v0 `crm.csv` contract).
- For monthly management follow-up: retail unit sales by store/day and matching DMS sales totals, with clear cancellation/return treatment.

Ensure exported CRM `sold` means an actual verified sold status, not a website conversion. If the same-day lead, appointment and sold figures represent different cohorts, do not calculate their ratios as though they are the same customers.

Use this exact daily aggregate file for the first importer:

`crm.csv` header: `date,store,business_line,leads,appointments,shows,sold`

Store IDs: `chevy`, `nissan`, `infiniti`, `cdjr-south`, `jeep-north`. Group account is not a store for CRM reporting. Empty numeric cells = unavailable, not zero.

## Connect next

- **Meta Ads / Microsoft Ads:** daily account-level spend, impressions, clicks, platform-reported conversions (with definitions); file `ads.csv` per contract. Keep marketing platforms distinct; do not double-count.
- **GA4:** sessions, VDP page views, lead form events by day and store, using `web.csv`.
- **Calls:** inbound, missed and answered definitions by store and day, using `calls.csv`.
- **Inventory + websites:** merchandising completeness, status, VDP pricing and inventory feeds as read-only validated datasets, later schema version.

## Reconciliation checklist

- Match each report to correct store/account, date range, time zone and currency.
- Match total ad spend to Google Ads or equivalent user interface.
- Check platform conversions vs CRM leads (they are different metrics and should not be assumed equal).
- Verify attribution windows, duplicates and whether offline upload occurs.
- Sign off source definitions in the internal data dictionary before publishing management conclusions.
