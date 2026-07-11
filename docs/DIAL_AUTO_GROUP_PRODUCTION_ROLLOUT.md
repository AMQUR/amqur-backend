# Dial Auto Group — Production Rollout Report

**Updated:** 2026-07-11 (final canary preparation pass)  
**Branches:** `ops/canary-pilot-rollout`  
**Production customer traffic:** **not enabled**  
**Live tag publish:** **not performed**

---

## PR #4 status

| Repo | PR | State | CI | Reviews | Mergeable | Action |
|---|---|---|---|---|---|---|
| amqur-backend | [PR #4](https://github.com/AMQUR/amqur-backend/pull/4) | open | build-test **success** | none | clean | Ready to merge when workflow owners approve; **not auto-merged** (docs/gates package; subsequent commits may land on same branch) |
| amqur-widget | [PR #4](https://github.com/AMQUR/amqur-widget/pull/4) | open | build **success** | none | clean | Same |

Source branch both: `ops/canary-pilot-rollout` → `main`.

---

## Local verification

| Check | Backend | Widget |
|---|---|---|
| npm ci | PASSED | PASSED |
| Prisma generate | PASSED | n/a |
| Prisma validate | PASSED (with dummy `DATABASE_URL` for CLI) | n/a |
| Typecheck | PASSED | PASSED (via `tsc -b` in build) |
| Unit / contract / truth / provider tests | PASSED **69** tests / 30 suites | PASSED **12** (+ canary package tests) |
| Tenant isolation (staging live) | PASSED (prior + config gates) | n/a |
| Production build | PASSED | PASSED |
| Migration destructive scan | PASSED — only `DROP INDEX/CONSTRAINT IF EXISTS` rebuilds | n/a |
| Dependency audit | INFO (known advisories; not release-blocking for canary prep) | INFO (vite advisories) |
| Secret scan tracked | PASSED | PASSED |
| IIFE secret scan | n/a | PASSED |
| Accessibility suite | UNAVAILABLE (not configured as separate job) | SKIPPED |
| Staging E2E (prior gate) | n/a | PASSED 12/12 |

---

## Access discovery

| Area | Label |
|---|---|
| Google Cloud CLI | BLOCKED BY ACCESS |
| GTM API / ADC | BLOCKED BY ACCESS |
| TeamVelocity / Apollo API | BLOCKED BY ACCESS |
| Keychain usable GTM secrets | BLOCKED BY ACCESS |
| Railway GTM/alert vars | BLOCKED BY ACCESS |
| GitHub Actions GTM secrets | NOT IMPLEMENTED |
| Official OAuth available to initiate | NOT IMPLEMENTED (no gcloud/gtm tool) |

Unavoidable authorization: Google account with GTM publish rights on observed containers **or** TeamVelocity script install.

---

## Live website integration surface (read-only)

| Item | Result | Label |
|---|---|---|
| GTM installed | Yes — containers listed below | READY |
| GTM IDs | GTM-MP5XGBXQ, GTM-MV862RN, GTM-NFTX3XB, GTM-PZR8D88Z, GTM-TPV8SZS7, GTM-WQP4BHQ4 | READY |
| TeamVelocity / dealer.com | Fingerprints + `pix-aop-auto.js` dealerCode `chryslerdodgejeepramofchicagoilcllc` | READY |
| CSP header | None observed | READY BUT DISABLED (document if added later) |
| Consent CMP | Not detected | READY |
| Async scripts | Present (gtag etc.) | READY |
| SPA full client router | Not detected | READY |
| Existing chat risk | Messaging/chat fingerprints present | READY BUT DISABLED — coordinate before launch |
| HSTS | Present | READY |
| Address public | 5950 N Western Ave, Chicago, IL 60659 | READY BUT DISABLED pending staff confirm |
| Phones public | Multiple numbers; department map unknown | BLOCKED |

No live changes made.

---

## Canary configuration audit

File: `config/canary-jeep-of-chicago.json`

| Field | Status |
|---|---|
| Tenant / location slugs | READY (proposed; not prod-seeded) |
| Hostnames | READY |
| API / CDN | BLOCKED — null, explicitly marked |
| Public inventory flags | READY — **disabled** (no live vAuto) |
| Tekion / outbound / voice | READY — disabled |
| Handoff | BLOCKED — destination unverified |
| Traffic levels 0–5 | READY BUT DISABLED (level 0 active) |
| Placeholders like example.com | PASSED (none used as live values) |

---

## GTM snippet / package audit

| Artifact | Label |
|---|---|
| `amqur-canary-loader.js` | READY BUT DISABLED |
| Levels 0–5 snippets | READY BUT DISABLED |
| `jeep-of-chicago-gtm-canary.md` | READY |
| TeamVelocity request template | READY |
| Activated on live site | FAILED / not attempted |

Loader enforces: hostname allowlist, kill switch, duplicate init guard, stable %, employee hash gate, HTTPS-only hosts, placeholder rejection, SPA nav kill re-check, consent hook, graceful asset failure.

---

## Customer-facing inventory decision

**Public inventory, compare, saved vehicles, payment estimator: DISABLED** until authorized live inventory exists.

Fixture inventory: staging / visibly labeled employee pages only — **release-blocking** if it appears in public mode (`hardDisabled: fixtureInventoryInPublicMode`).

Safe without live inventory (still blocked on handoff/access): lead capture, service/parts request collection, multilingual, education, handoff **once destination verified**.

---

## Human-handoff readiness

**BLOCKED BY ACCESS** — see `docs/dealership-knowledge/jeep-of-chicago-handoff.md`.

---

## Verified dealership knowledge

See `docs/dealership-knowledge/jeep-of-chicago-sources.md`.  
Most hours/phone routing: **BLOCKED** until staff-approved source.

---

## Analytics / monitoring

| Item | Label |
|---|---|
| Health / metrics APIs | READY |
| Canary diag events (`amqur:diag`) | READY BUT DISABLED |
| Alert routing recipients | BLOCKED BY ACCESS |
| Auto-pause criteria | READY (documented in config) |
| CWV budget automation | NOT IMPLEMENTED |

---

## Canary levels

| Level | Prepared | Active |
|---|---|---|
| 0 Disabled | READY | yes |
| 1 Employee | READY BUT DISABLED | no |
| 2 1% | READY BUT DISABLED | no |
| 3 5% | READY BUT DISABLED | no |
| 4 25% | READY BUT DISABLED | no |
| 5 Full rooftop | READY BUT DISABLED | no |

---

## Rollback readiness

| Path | Label |
|---|---|
| GTM Level 0 / prior container | READY (operator) |
| Feature flag chat=false | READY (code) |
| CDN version pin | READY BUT DISABLED (CDN not provisioned) |
| Staging redeploy smoke (prior) | PASSED |

---

## Tekion / vAuto

| | |
|---|---|
| Tekion | READY BUT DISABLED — vendor credentials absent |
| vAuto | READY BUT DISABLED — no authorized feed |

---

## Exact remaining blockers (external)

1. GTM publish access **or** TeamVelocity install approval  
2. Provisioned production API origin + CORS/allowedOrigins  
3. Provisioned HTTPS widget CDN + versioned IIFE (+ optional SRI)  
4. Verified human-handoff destination + approved test  
5. Alert routing to verified recipients  
6. Staff-confirmed hours/phone department map (for those answers)  
7. Authorized live inventory before enabling public inventory features  
8. Explicit approval before any container publish  

---

## Security review (package)

| Check | Result |
|---|---|
| No GTM/Railway/JWT/DB/Redis/Tekion secrets in snippets | PASSED |
| Fail-closed missing hosts | PASSED |
| Hostname allowlist | PASSED |
| Production rejects localhost/placeholders | PASSED |
| Fixture inventory blocked in public mode config | PASSED |

---

## Verdict

**NOT READY FOR CUSTOMER TRAFFIC**

Also **not** ready for internal employee canary on the **production hostname** until production API/CDN are provisioned and fail-closed loader hosts are set. Employee testing remains on **staging labeled hosts** only.
