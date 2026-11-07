# AMQUR Phase 1 — release certification ledger
**Recorded:** 2026-11-07 (America/Chicago)  
**Status:** **NO-GO for production promotion and public rooftop activation**. Evidence below does not imply a live customer launch.

## Release candidates
- Backend integrated PR: https://github.com/AMQUR/amqur-backend/pull/33
- Widget integrated PR: https://github.com/AMQUR/amqur-widget/pull/24
- Source CI runs: verify `head_sha` and **final** `conclusion=success` on each PR before merging. Earlier successful runs on older SHAs do not certify a later change.
- Current reference production according to 2026-11-06 operator evidence: backend `1ff5420`, widget `2b3a4b4`. Re-check provider runtime before claiming current deployment.
- Prior staging generative canary on `54168cb`: 150 PASS / 0 FAIL, 26 accepted model replies across five tenants; historical proof **only**, not attestation of future merge SHAs.

## Newly enforced in both candidate repositories
1. **Production evidence preflight** (`scripts/production-release-gate.mjs`) runs before any production Railway CLI action, after any configured GitHub environment approval. It fails closed on a missing/mismatched exact merge SHA or absent/stale backup restore and delivered-alert references.
2. **Fresh evidence, not placeholders.** For each repository, configure the following **non-secret GitHub `production` environment variables**, only after reviewing real provider receipts:
   - `AMQUR_PRODUCTION_APPROVED_SHA`: exact 40-digit merged commit SHA of that repository, reviewed for this promotion.
   - `AMQUR_BACKUP_RESTORE_RECEIPT`: unique, genuine snapshot + **isolated** restoration proof reference (at least 16 characters; never a fabricated placeholder).
   - `AMQUR_BACKUP_RESTORE_AT`: UTC `YYYY-MM-DDTHH:MM:SSZ`, event within 30 days.
   - `AMQUR_ALERT_DELIVERY_RECEIPT`: unique alert delivery proof reference (different from backup ID).
   - `AMQUR_ALERT_DELIVERY_AT`: UTC `YYYY-MM-DDTHH:MM:SSZ`, event within 30 days.
   The preflight **only validates references, recency, and commit binding**, not truthfulness of underlying external evidence; independently inspect the actual provider records. It deliberately prints only validation labels.
3. **Backend staging model canary** now runs in the automatic staging Deploy job with exact deployed SHA and must produce accepted, grounded model-written replies for **each** of the five tenants. Safety-only, discarded, wrong-SHA, missing model, or wrong host are failures.
4. **Widget Railway config** defaults to production-safe CDN `Dockerfile` so an unexpected direct GitHub-connected build does not ship employee-only staging HTML. Staging GitHub Actions Deploy explicitly substitutes `Dockerfile.staging`. Direct Railway staging connections must override this in the staging service settings. The production image rejects the staging banner.
5. Regression tests and CI checks guard the above changes. Never treat a queued/in-progress run as passed.

## External gating evidence still required
| Gate | Required objective proof | As of this ledger |
|---|---|---|
| Verified backup/restore | Successful actual Postgres backup ID, timestamp, retention, encrypted offsite plan, restore into fresh non-production instance, migration/table-count checks, measured RPO and RTO | **OPEN** — historical Railway Hobby plan showed zero volume backup allowance; current plan/permissions not independently inspected |
| Alert delivery | Configure `ERROR_MONITORING_DSN` in staging + prod API and worker without revealing values; inject safe synthetic event; verify receipt and recipient/on-call routing | **OPEN** — last provider evidence said absent |
| Current staging AI | Deploy exact backend PR merge SHA to staging, confirm `/api/version`, pass 5-tenant accepted generative probe after merge (not just historical `54168cb`) | **OPEN for new SHA** |
| Current staging widget | Deploy exact widget SHA, test version + IIFE + employee-only label, browsers (Chromium, Firefox, WebKit, mobile), accessibility, CORS, Shadow DOM | **OPEN for new SHA** |
| CI | Final successful runs on both current heads and final merged `main` SHAs | **OPEN while CI is pending** |
| Production environment controls | Independently confirm GitHub production required reviewers, Railway deploy permissions, absence of uncontrolled direct auto-deploy bypass | **OPEN — GitHub connector cannot read protected environment settings** |
| Production fail-closed | Confirm production origins/flags remain closed, verify 403 unauthorized token and no public activation, correct SHA and healthy API/worker/CDN | **OPEN for real-time recheck** |
| Rooftop content | Owner-verified hours/phone/address per store, correct inventory provenance, legal offers/disclaimers, lead escalation recipients | **OPEN** |
| Live integrations | Approved HTTPS inventory feeds, Tekion contract + partner credentials, CRM/webhook endpoints, Twilio/Meta/voice only if separately enabled | **OPEN, external/vendor dependent** |
| Human acceptance + leadership | Employee canary transcript, dealership IT and leadership approval for first rooftop; gradual go-live plan | **OPEN; cannot fabricate signatures** |

## Safe execution order
1. Finish exact-head CI, review diffs for secrets and unsafe behavior.
2. Obtain Railway connection and check current staging/prod deployments and backup plan. Do not upgrade billing, restore live DB, or alter production flags without specific operational evidence and authorization.
3. Create and verify a real backup/restore receipt in an isolated service; collect actual measured RPO/RTO.
4. Privately configure monitoring DSN and verify actual alert delivery; do not print or commit credentials.
5. Confirm GitHub production environments require reviewers and that any direct Railway deploys cannot bypass controlled release.
6. Merge reviewed candidates after successful exact-head CI and safeguards. Allow staging Deploy jobs, check SHA and strict canaries. Production job remains blocked until evidence variables and manual review.
7. Conduct employee browser tests and store-by-store factual data verification.
8. Promote production code only after all release preflight and external receipts pass. Keep all public `allowedOrigins` empty and vendor features off.
9. Separately authorize public pilot, verify one rooftop at a time, watch grounding/latency/lead delivery and rollback if required.

**Hard invariant:** CI success is not proof of restore, monitoring, vendor integrations, employee acceptance, or customer launch; never report platform 100/100 while any mandatory gate is open.
