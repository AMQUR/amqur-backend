# Dial Auto Group — Production Rollout Report

**Date:** 2026-07-11  
**Authoring branch:** `ops/canary-pilot-rollout`  
**Scope:** Post-staging canary preparation for one Dial Auto Group rooftop  
**Production customer traffic:** **not enabled**

---

## Staging results

| Gate | Result |
|---|---|
| `STAGING_PILOT_GO_NO_GO.md` verdict | **GO FOR INTERNAL STAGING TESTING** |
| Staging API health | PASSED (`/api/health/live`, `/api/health`) |
| Staging widget host | PASSED |
| Playwright staging E2E | **12/12 PASSED** (re-run 2026-07-11) |
| Origin-restricted widget tokens | PASSED (evil/missing 403; allowed 201) |
| Tenant isolation (unknown tenant) | PASSED 401 Invalid tenant |
| Stale / fabricated inventory claims | PASSED (no ready-for-pickup / final APR claims) |
| Secret scan (tracked) | PASSED |
| Staging rollback smoke | PASSED (`railway redeploy --service widget-staging`; host remained 200) |
| Staging PRs merged to `main` | PASSED — backend [#3](https://github.com/AMQUR/amqur-backend/pull/3), widget [#3](https://github.com/AMQUR/amqur-widget/pull/3) |
| `main` CI | PASSED (backend `7f5e583`, widget `951eedb`) |

Staging URLs (internal only):
- API: https://backend-staging-staging-b699.up.railway.app  
- Widget: https://widget-staging-staging.up.railway.app  

---

## Tekion readiness

| Item | Status |
|---|---|
| Adapter + mock + contract tests | Present |
| Official credentials in secure stores | **NOT FOUND** |
| Sandbox verification (16-step checklist) | **NOT RUN** |
| Production Tekion | **DISABLED** |

Artifact: `docs/integrations/TEKION_VENDOR_ONBOARDING.md`

---

## vAuto readiness

| Item | Status |
|---|---|
| Authorized feed download pipeline | Present in code |
| Live authorized feed URL/credentials | **NOT FOUND** |
| Staging inventory | Fixture XML only |
| Repeated live imports | **NOT RUN** |
| Production vAuto | **DISABLED** |

Artifact: `docs/integrations/VAUTO_FEED_ONBOARDING.md`

---

## Pilot rooftop selection

**Selected:** Jeep of Chicago — https://www.jeepofchicago.com  

**Why:** single-brand rooftop; GTM containers observed; TeamVelocity/dealer.com fingerprint; lower blast radius than group site.

**Not selected this phase:** dialnissan.com, dialchevy.com, dialjeep.com, dialautogroup.com (see `config/canary-jeep-of-chicago.json`).

**Proposed mapping (not seeded in production DB):**
- tenantSlug: `dial-auto-group`
- locationSlug: `jeep-of-chicago`

---

## Enabled features (when canary goes live)

chat, inventory (verified source only), vehicle cards/compare, saved vehicles, lead capture, payment estimates w/ assumptions, service/parts request collection, EN/ES, human handoff, safe proactive engagement, analytics/provenance, lead scoring, copilot.

## Disabled until independently verified

Tekion live, live vAuto feed, autonomous confirmed scheduling, repair-order status claims, automated outbound follow-up, voice, finance approval claims, incentives without authority, cross-store inventory, unsupervised CRM mutations.

---

## Deployment versions

| Component | Version / commit |
|---|---|
| Backend `main` | `7f5e583` (includes staging automation) |
| Widget `main` | `951eedb` |
| Staging backend deploy | Railway `85dd1a42-…` SUCCESS |
| Staging widget deploy | Railway `bb2b48c9-…` SUCCESS (redeploy smoke OK) |
| Production API / CDN | **Not provisioned for canary** |

---

## Website installation method

| Item | Detail |
|---|---|
| Preferred path | Google Tag Manager Custom HTML (async snippet) |
| Observed GTM IDs | GTM-MP5XGBXQ, GTM-MV862RN, GTM-PZR8D88Z, GTM-TPV8SZS7, GTM-WQP4BHQ4 |
| CMS | TeamVelocity / dealer.com |
| Snippet prepared | `amqur-widget/docs/canary-gtm-snippet.html` |
| Installed on live site | **NO** |
| Blocker | No authenticated GTM / TeamVelocity / dealer.com API or deployment credential on this machine |

No production admin panel automation was attempted (not auditable without official API).

---

## Canary progression

Configured in `config/canary-jeep-of-chicago.json`.

| Phase | Audience | % | Status |
|---|---|---|---|
| 0 | — | — | **Current** — prepared only |
| 1 | Internal employees | 0 | Blocked on install + inventory + alerts |
| 2 | Allowlisted testers | 0 | Blocked |
| 3–6 | Customers 5→100% | — | Blocked |

Auto-pause triggers documented (stale inventory, claim detection, CORS/token spikes, isolation failure, CWV regression, Tekion/lead failures).

---

## Analytics / observability

| Item | Status |
|---|---|
| Health + staff metrics APIs | Available |
| Shared multi-instance metrics | Not configured (single-instance staging) |
| Dashboards | Spec only — `docs/OBSERVABILITY_CANARY.md` |
| Alert routing | **Not configured** (no verified recipients / webhooks) |

**Customer traffic must not start until alert routing is verified.**

---

## Incidents

None in staging canary preparation window. Prior staging Prisma openssl crash was fixed before GO.

---

## Rollback tests

| Test | Result |
|---|---|
| Staging widget `railway redeploy` | PASSED — site remained HTTP 200 |
| Documented image/flag/tag rollback | Documented in staging go/no-go + observability doc |
| Destructive DB rollback | **Not performed** (forbidden) |

---

## Security results

| Check | Result |
|---|---|
| Widget origin fail-closed | PASSED |
| Bootstrap disabled on staging | PASSED (prior) |
| Secrets not in Git | PASSED |
| No Tekion/vAuto secrets printed | PASSED |

---

## Tenant-isolation results

Unknown tenant token mint → 401. Staging origin allowlist enforced. Cross-store inventory remains disabled in canary config.

---

## Inventory-freshness results

Staging: fixture inventory with staging labels. Live freshness pipeline not exercised (no authorized feed).

---

## Lead-delivery results

Staging chat persists to AMQUR DB. Tekion writeback disabled. No production lead routing verified (no staff inbox / CRM webhook confirmed for Jeep of Chicago).

---

## Remaining vendor dependencies

1. Tekion partner credentials + sandbox docs  
2. Authorized vAuto (or equivalent) feed per rooftop  
3. GTM or TeamVelocity deploy access for jeepofchicago.com  
4. Production Railway (or equivalent) API + CDN with staging-proven config  
5. Verified alert routing destination  
6. Dealership-approved handoff phone/email for Jeep of Chicago  
7. Management approval to enter phase 1 (employees only)

---

## Per-rooftop readiness

| Rooftop | Site | Ready? | Notes |
|---|---|---|---|
| Jeep of Chicago | jeepofchicago.com | **NO** | Canary config + GTM snippet only |
| Dial Nissan | dialnissan.com | NO | Install path unclear |
| Dial Chevy | dialchevy.com | NO | DealerOn; deferred |
| Dial Jeep (alt) | dialjeep.com | NO | Prefer Jeep of Chicago |
| Group site | dialautogroup.com | NO | Not a rooftop canary |

Cross-store inventory: **disabled** for all.

---

## Verdict

**NOT READY FOR CUSTOMER TRAFFIC**

Rationale: staging is GO for internal testing, but Tekion credentials, authorized vAuto feed, production API/CDN, live GTM install authorization, lead routing, and alert routing are all outstanding. Canary remains at phase 0 (prepared, not installed).
