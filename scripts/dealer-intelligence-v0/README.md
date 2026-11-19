# AMQUR Dealer Intelligence v0 | Free Dial Auto Group flagship

Runnable, read-only, zero-dependency Node.js 22 scorecard for the five rooftops and a **separate** Dial group advertising account. It extends the existing AMQUR backend without touching NestJS services, migrations, ad accounts, Tekion or live website features.

## Run

```bash
node --test scripts/dealer-intelligence-v0/scorecard.test.mjs
node scripts/dealer-intelligence-v0/scorecard.mjs \
  --data scripts/dealer-intelligence-v0/fixtures/synthetic \
  --out /tmp/amqur-dealer-intelligence-demo \
  --as-of 2026-11-10
```

Outputs: `report.md` (owner briefing) and `report.json` (machine-readable store metrics + approval-ready actions). The synthetic fixture is permanently labelled as synthetic. For live reports pass `--data` and `--out` paths **outside this public GitHub repository**, with only aggregate daily data (no lead/contact/customer rows).

## CSV contracts (UTF-8, exact headers; files optional; missing is unknown)

| File | Exact header | Source |
|---|---|---|
| `ads.csv` | `date,store,platform,business_line,spend_usd,impressions,clicks,reported_conversions` | Google / Meta / Microsoft Ads account-level daily aggregate |
| `crm.csv` | `date,store,business_line,leads,appointments,shows,sold` | Tekion **aggregates**, with definitions and DMS verification pending |
| `web.csv` | `date,store,sessions,vdps,form_submissions` | GA4 verified aggregate |
| `calls.csv` | `date,store,inbound_calls,missed_calls` | Verified aggregate call tracking |

Stores must match `config/rooftops/registry.json` keys: `chevy`, `nissan`, `infiniti`, `cdjr-south`, `jeep-north`, plus `group` **for central paid media only**. Do not confuse CDJR South with Jeep North. `business_line`: `new`, `used`, `service`, `parts`, `other`, or `unclassified`. `platform`: `google_ads`, `meta_ads`, or `microsoft_ads`. Each file represents one daily aggregate per unique store+source+business-line key. Count columns are nonnegative integers; **reported_conversions can be fractional** because Google may attribute fractional conversions. Blank means unavailable and is different from 0.

The report only covers the seven calendar dates ending `--as-of` in the America/Chicago business calendar. It never claims that platform conversions are sold units. No calls or SMS are sent. No budgets, prices, records or websites are changed.

## Source-of-truth and security gates

1. Real aggregate CSVs and output belong in a private encrypted location, not Git history (this backend repository is currently public).
2. For live data, reconcile spend to the original advertising platform for matching dates/currencies. Normalize account IDs to the correct store. Document conversion action definitions before making performance claims.
3. Tekion reporting should exclude customer names, emails, phone numbers, VIN-linked customer details, SSNs, financial records, and notes. Use store/day/business-line totals only.
4. Report quality is `Usable with limits` until account figures and CRM lead definitions are reconciled. Missing sources show `Unreliable`, and missing metric values remain `N/A`.
5. Every action in the register starts `Needs Review` and `Implemented=No`; it is not approval to change campaigns. Consent and customer-contact compliance are separate gates.
6. Build official API adapters only after vendor authorization and contract verification; never reverse engineer Tekion APIs or bypass browser security.

## Next integrations (not implemented)

- Google Ads read-only connector: six accounts already available through a connected reporting service; central group account stays separate.
- Meta, Microsoft Ads, GA4: connect reporting source or supply verified daily aggregate exports.
- Tekion/DMS: use authorized report exports until vendor-supported API access exists.
- Transition from this proof-of-value tool to an isolated `Dealer Intelligence` module in AMQUR's existing multi-tenant backend after tests, data governance, and production gates pass.
