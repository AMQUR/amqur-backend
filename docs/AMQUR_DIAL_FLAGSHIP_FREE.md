# AMQUR x Dial Auto Group: Flagship Client 001

**Status:** Active proof-of-value build (not production authorized)  
**Commercial agreement:** $0 for all five rooftops and Dial's central account. No deferred fees or implied future billing.  
**Relationship:** Family-affiliated first client. Future public case studies must disclose the relationship when material.  
**Pilot focus:** Evidence-backed decisions that improve sales, service, customer responsiveness, marketing efficiency, and management reporting.

## Operating boundaries

- Family ownership and account access are not equivalent to vendor/API permission; retain a named internal owner and use least-privilege read-only access for each system.
- Never put real customer data, live API secrets or unredacted dealership exports into GitHub. The existing AMQUR backend repo is public.
- No unapproved ad budget change, campaign change, site publish, GBP edit, price adjustment, outbound message, CRM write, or chatbot installation.
- Customer-facing AMQUR public activation remains blocked until existing production release gates (backup/restore, alert delivery, acceptance, monitoring, approvals) pass.
- Existing Tekion integration is fail-closed and has no verified live vendor client. Do not invent endpoints or bypass browser security checks.
- Protect brand/vendor rules and the FTC Safeguards Rule; do not process consumer financial/credit or personally identifiable records in the first reporting pilot.

## Rollout sequence

| Stage | Scope | Exit evidence |
|---|---|---|
| 0 | Five-store identity and connected-source inventory | Six Google Ads accounts mapped, website vendors and group account separated |
| 1 | Google Ads seven-day read-only baseline | Six-account source response and group summary; no CRM attribution claims |
| 2 | Tekion aggregate leads/appointments/shows/sold | Store-day source definitions and reconciliation against Tekion reports |
| 3 | Meta, Microsoft, GA4, call tracking, inventory | Daily reporting coverage and provenance by source/store |
| 4 | One owner morning brief + approval action register | 7 consecutive business-day reviews; evidence links and no unapproved changes |
| 5 | Controlled recommendation -> approval -> verify loop | Closed-loop before/after measurement with decision owner and rollback plan |
| 6 | Case study | Written consent, defensible baseline and results, affiliated relationship disclosure |

## Five rooftop mapping

The source of truth for IDs is `config/rooftops/registry.json` in the existing AMQUR backend. The central Dial Auto Group advertising account is **not a sixth rooftop** and its spend must not be quietly allocated to any one store. Keep South CDJR and Jeep North distinct even when public websites use similar CDJR branding.

## Initial outcomes and KPIs

1. **New and used vehicle sales**: qualified lead volume, response time, appointments set, shows, sold outcomes, source-to-sale attribution (after Tekion and DMS data verification).
2. **Service**: booked appointments, RO count, missed service calls, retained customers, service revenue/gross where verified.
3. **Media**: channel spend, wasted-spend candidates, campaigns with zero *verified* outcomes, lead quality, cost per appointment and cost per sold when denominators reconcile.
4. **Web / GBP**: healthy forms and calls, inventory/price integrity, actionable SEO/GBP findings with dated evidence.
5. **Delivery quality**: reports delivered; recommendations traceable; data freshness; zero unauthorized writes; action impacts measured against defensible baselines.

No default revenue attribution or ROI percentages are to be fabricated. A paid-media conversion is not a sold vehicle. A saved edit or vendor request is not an implemented fix.

## What we already know

- Existing platform: `AMQUR/amqur-backend`, `AMQUR/amqur-widget`, Railway staging/production.
- Backend Phase 1 PR #33 and dependency-remediation PR #36 are open; widget PR #24 is open. Do not bypass their release blockers or merge/deploy as part of this reporting pilot.
- Six Dial Google Ads accounts are connected through Supermetrics reporting. Meta, Microsoft Ads, GA4 and GBP are **not authenticated in that connector**; they may still be accessible to staff in their own interfaces.
- Tekion browser tab was visible but its secure read operation failed; no bypass attempted. Authorized CSV/aggregate export is the current data route.
- Seven-day Google Ads evidence from 2026-11-04 through 2026-11-10 is held outside GitHub in private scorecard artifacts, not embedded here.

## First two weeks

**Days 1-2:** Publish this program plan and runnable, read-only scorecard into an isolated review branch. Capture the Google baseline. Export *aggregate only* Tekion lead/funnel numbers for five rooftops; verify date and definition.

**Days 3-5:** Ingest Meta and Microsoft advertising by approved connection/export. Add GA4 and calls. Reconcile all account-to-store mappings and create source reliability status.

**Days 6-10:** Deliver first morning brief and ranked approval action register. Verify findings in source UIs, then obtain specific approvals before any implementation.

**Days 11-14:** Review before/after outcomes with leadership, publish a private case-study outline, select the next reliable agent (executive brief or lead response drafts with consent and human approval).

## Testimonial and referral strategy

After tangible verified value: ask for a voluntary testimonial and permission to reference Dial by name, logo and results; keep a written approval record. In proposals to outside customers, disclose the family-affiliated first-client relationship where material. Request warm introductions to owners and GMs. Publish only aggregate results approved for release. An internal free pilot is **not** AMQUR revenue.

## Acceptance criteria for the first reporting agent

- Five rooftop rows plus separate central account spend.
- Seven-day window in America/Chicago; source freshness and missingness shown.
- No duplicate store-day-platform-business line rows; no personal-data columns accepted.
- Fractional platform conversions preserved, not renamed to leads.
- All action register entries default to `Needs Review` and `Implemented=No`.
- No production changes, credentials, PII, live customer messages, or automated spend.
- Unit tests pass and synthetic fixtures are conspicuously marked.
