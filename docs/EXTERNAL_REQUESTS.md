# External requests — ready to send

Each request below names exactly what is needed, who supplies it, and what AMQUR does with it. Nothing has been sent; these are drafts for the platform owner to send. No purchases, registrations or contracts were made.

---

## 1. Tekion — partner API access and credit-application link (B-01, B-05)

**To:** Tekion partner program / Dial Auto Group's Tekion account manager

> We are integrating AMQUR (dealer AI assistant) with Tekion for Dial Auto Group. Please provide:
> 1. Automotive Partner Cloud access and the official API specification for: CRM customer lookup/create/update, lead create/update with source attribution, activity/notes, lead assignment; service appointment availability/create/update/cancel; repair-order status (read); parts catalog/VIN fitment/availability/pricing; webhook signing specification.
> 2. Sandbox base URL and OAuth client credentials; then production credentials after our contract tests pass.
> 3. Dealer ID and store ID for each rooftop: Dial Chevy of Chicago, Dial Nissan of Chicago, INFINITI of Chicago, Dial CDJR of Chicago (South, dialjeep.com), Jeep of Chicago / CDJR of Chicago (North, jeepofchicago.com) — and which of these use Tekion at all.
> 4. **Consumer credit application links** (`consumer-credit.tekioncloud.com/creditApplication?token=…`): is the token (a) a public reusable link, (b) reusable but specific to one store, or (c) issued per customer/session? Does it expire? Which store does the token we were given belong to? If per-customer, what is the official API to issue one per shopper? Is there a completion callback/webhook? Should the token we were given be rotated (it was shared in a chat transcript)?

**AMQUR does with it:** implements `TekionHttpClient` strictly from the spec inside the existing fail-closed adapter, runs sandbox contract tests, records link type + authorization per store (Command Center → Secure credit application).

## 2. Dealership (each rooftop GM) — store facts and approvals (B-03, B-04, B-05, B-06, B-14)

> For each store, please confirm in writing:
> - Legal/public store name, address, main/sales/service/parts phone numbers.
> - Weekly hours for sales, service and parts; holiday closures for the next 12 months.
> - Shuttle/loaner/wait-area policies.
> - Handoff: who receives "talk to a person" requests during and after hours, the destination (CRM ADF email-to-lead or webhook), and response-time expectations.
> - Credit application: approval to use the Tekion link for this store (reference that we will record), or the correct link.
> - Out-the-door: Illinois sales-tax rate/basis to use, documentation fee and whether it is already included in advertised prices, title/registration/plate charges, any other mandatory fees — reviewed by your counsel/finance director.
> - Named employees for the internal canary, the rollback owner, and the signed production release approval.

## 3. vAuto / inventory source owner (B-02)

> Please authorize an inventory feed for AMQUR for each store: feed URL or SFTP/API credentials, the store ↔ feed ID mapping, field list (including photo URLs that are licensed for display), and refresh cadence.

## 4. Website providers — Team Velocity (Jeep of Chicago observed) and DealerOn (Dial Chevy observed) (B-10)

> We'd like to install the AMQUR assistant on: [store URL]. Please confirm (1) you host this site, (2) the approved install method (Apollo pixel / GTM container / site script), (3) CSP or tag-manager constraints, and (4) the exact production origins. Install package: `docs/WEBSITE_INSTALL_PACKAGE.md`. We will not publish until the dealership has approved in writing.
>
> Note: dialnissan.com, infinitichicago.com and dialjeep.com returned HTTP 403 to a read-only check, so we could not identify their provider — please confirm.

## 5. Valuation provider (trade-in dollar values) — choose one

> AMQUR needs a licensed trade-in valuation with display rights to consumers (or staff-only use). Candidates: vAuto, Manheim MMR, CARFAX History-Based Value, KBB, Black Book, ACV/ClearCar. Please send API documentation, licensing terms for **consumer display**, and pricing.

Until then, AMQUR shows trade values only when a dealership manager issues an offer in the Command Center.

## 6. Twilio (SMS) — platform owner action (B-07)

Purchasing numbers, A2P 10DLC brand/campaign registration and accepting Twilio terms are owner actions. Needed: account SID, auth token, Messaging Service SID, approved sender(s), consent wording approved by dealership counsel.

## 7. Email provider, WhatsApp Business, voice (B-08, B-09)

Vendor choice required before any adapter is written: email (SendGrid/Postmark/SES + verified domain), WhatsApp Business account, telephony provider + numbers + routing + recording-consent policy.

## 8. Railway (platform owner) — staging, backups, monitoring (B-11, B-12, B-15)

> The engineering CLI session expired and engineering does not log in on the owner's behalf. Please either (a) run `railway login` in a session engineering can use, or (b) provide a scoped project token. Then we will: verify staging deploys of PRs #28/#21 after merge, confirm Postgres backup schedule/retention and run a non-production restore drill, confirm `pgvector` availability, and set `ERROR_MONITORING_DSN`.

## 9. Dealership counsel

Review: consent wording (TCPA/SMS), AI disclosure text, OTD/price disclosures and doc-fee handling under Illinois law and FTC Act Section 5 (the FTC CARS Rule was vacated by the Fifth Circuit on 2025-01-27), credit-application handoff (FTC Safeguards Rule/GLBA scope), data retention periods.
