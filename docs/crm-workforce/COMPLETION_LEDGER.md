# AMQUR CRM Workforce — completion ledger (authoritative)

**As of 2026-11-26.** Production runs `b8cc6fa` (Release 4, tag `prod-2026-11-26-crmwf-r4`). This ledger supersedes `IMPLEMENTATION_LEDGER.md` for status. Evidence is cited by file, test or release record. Approval IDs refer to `APPROVAL_REGISTER.md`.

Status vocabulary:
- **PV** — completed, production-verified.
- **ND** — implemented, not deployed (Release 4 candidate).
- **DV** — deployed, not verified with real use.
- **PI** — partially implemented.
- **IA** — internally actionable.
- **EA** — external authorization required.
- **ET** — external technical dependency.
- **NA** — not applicable.

## 1. Platform and production

| Item | Status | Evidence / next |
|---|---|---|
| Additive module, concierge untouched | PV | 3 releases; `/api/version`; Concierge routes unchanged |
| Production API + worker, migrations applied once | PV | R1–R3 evidence files; `_prisma_migrations` checks |
| Staging rehearsal before each release | PV | R2/R3 smoke checks on staging |
| Release lineage guard | PV | `scripts/release/verify-lineage.sh`; refuses `main` today |
| Reviewed deploy path from `main` | PI | G1–G3 done 2026-11-26 (`main` contains production; workflow retargeted; main protected). First run stopped safely: token lacks access (G4) |
| Tags for every production deploy | PV | `prod-2026-11-25-*` pushed |

## 2. Product and administration

| Item | Status | Evidence / next |
|---|---|---|
| Today workspace, assisted drafting, "I sent this", replies, takeover | DV | Live in Assist at 5 stores; no employee has used it yet |
| Appointments / follow-ups as staff requests | DV | Work items; never "confirmed" without a CRM reference |
| Lead recovery queues (10 queues, cohorts 7–365+ days) | DV | `mining.service.ts`; empty until data exists |
| Draft approvals, modes, kill switches at every scope | PV | Controls; group stop; tests |
| Dealership switching, group dashboard | PV | R2; owner GROUP_ADMIN |
| Invitations, password reset, roles, deactivation | PV | R2 (people management) |
| Offboarding, staff access log, failed sign-in audit | DV | R4; integration tests |
| Department hours editor | DV | R4 Settings |
| Cost limits per store, model cost accounting | PV/PI | Limits live; cost shows "unknown" until `LLM_COST_*` prices are set (IA, owner supplies prices) |
| Communication policy view | PV | read-only; counsel approval R7 pending |
| Agent training (ratings, golden set) | PV/PI | Ratings screen; 63-case golden set; manager-written guidance arrives in R4 |
| Emergency shutdown (store, department, workflow, salesperson, group, global env) | PV | Tested; group stop in R2 |

## 3. Shared dealership knowledge

| Item | Status | Evidence / next |
|---|---|---|
| One knowledge layer for Concierge + Workforce | DV | `src/dealer-knowledge`; no second database for existing kinds |
| Identity, address, phones, website and handoff links | PV | Verified dealer directory (owner-approved 2026-11-12), used by both systems |
| Store, department and holiday hours | EA (D1) | Editor exists; **no store has entered hours**; health shows MISSING |
| Staff directory, managers, escalation contacts | DV + EA (D2/D3) | Entries with approval; none supplied yet |
| Offers / specials / OEM incentives | PV mechanism, EA (D4) | Spotlights with approval and expiry; none approved; no OEM source |
| Customer policies, agent guidance | DV + EA (D5) | Entries; group-site policies are drafts pending legal |
| Missing / stale / expired / conflict detection | DV | `health()`; integration tests |
| Manager review and approval interface | DV | Store knowledge tab |

## 4. Inventory

| Item | Status | Evidence / next |
|---|---|---|
| Ingestion pipeline (vAuto SFTP, ten source keys, anomaly guards, lifecycle, no SOLD from absence) | PV code, ET (V1) | Off in production: `INVENTORY_SYNC_ENABLED=false`, `AMQUR_VAUTO_SFTP_ENABLED=false`, no reader credentials |
| Feeds arriving: Chevy, Nissan, INFINITI, CDJR South, Jeep North × new/used | ET | **0 of 10 arriving.** Missing: reader credentials + switches (V1). The group site's historical feed host also returns 401 |
| VIN / stock / make-model lookup, store ownership, freshness, alternatives, VDP link | DV | Workforce uses the Concierge `InventoryEngine`; fresh-only facts; alternatives |
| Prices | EA (V2) | `AMQUR_VAUTO_PUBLISH_PRICES=false`; agents never quote price |
| Google VLA feeds | NA | External project; untouched |

## 5. AI workforce, communication, BDC workflows

| Item | Status | Evidence / next |
|---|---|---|
| 18 logical responsibilities (mission, limits, state, workload) | DV | `agents/roster.ts`; Roster card |
| Deterministic compliance outside the model | PV | `compliance.engine.ts`, tests |
| Output guard (claims, tone, identity) | PV | 191 unit tests; golden set; two false positives and one bypass fixed |
| EN/ES opt-out and escalation detection | PV | Golden inbound set |
| Sales / Service / Parts / Lead Recovery playbooks in Assist | DV | All five stores; synthetic and staging drafts only |
| Supervised / autonomous sending | EA (R7, R11, R12, T1) | Blocked by design |

## 6. CRM connection

| Item | Status | Evidence / next |
|---|---|---|
| Employee-assisted method (A) | PV | Live |
| Export import (B) | PV code, EA (R4) | Real files refused until authorized |
| Tekion APC (D) | EA (T1) | Contracts, adapter seams, `TEKION_CONNECTOR_TASKS.md` |
| Authorized browser (C) | EA (T2/T3) | Contract only; no driver by design |
| Reply detection, appointment availability | PI | Contracts + rules + tests; BLOCKED sources until Tekion |
| ADF outbound lead delivery | PV (separate) | `ADF_SEND_ENABLED=true`; not a CRM read |
| LeadsBridge | NA today | Not in code; would be a new-lead source only |

## 7. Security, privacy, DR

| Item | Status | Evidence / next |
|---|---|---|
| MFA for ADMIN/SUPER_ADMIN | PV | Production; 4 of 5 owner accounts still to enrol (owner action at first sign-in) |
| Tenant isolation, group scope, cross-dealership admin protection | PV | Tests; security-review fixes |
| Field encryption, keyed hashes, rotation | PV | R3; production holds 0 sealed values |
| Dedicated keys | PV | Set 2026-11-26; vault key id `1f4065b4`; copies outside Railway: K1 |
| Platform privacy export/delete covers Workforce | DV | Contributor registry; test |
| Retention purge, legal hold | PV | Daily purge |
| Backups: encrypted, verified, restore rehearsed | PV | `DISASTER_RECOVERY.md` |
| Off-volume + scheduled backups | EA (I1/I2) | Design ready |
| Backup key custody | EA (K1) | Single local copy today |

## 8. Reporting and cost

| Item | Status | Evidence / next |
|---|---|---|
| Morning / midday / end-of-day / weekly reports (on request) | PV | Performance tab |
| Scheduled delivery + critical alerts | DV, EA (R14) | Off until R14; once-only delivery tested |
| Executive group view | PV | Group overview with membership |
| Verified vs attributed outcomes; unknown ≠ 0 | PV | Report labels; cost "unknown" |
| Historical baseline | ET | Needs authorized CRM data (R4 / T1) |

## 100-point assessment

These scores use the owner's 2026-11-25 rubric. Earlier reports scored "engineering readiness" on a different basis and are not comparable. No points are given for contracts, mocks, synthetic drafts or settings alone.

| # | Area | Max | Engineering completeness | Verified in production |
|---|---|---|---|---|
| 1 | Architecture and production isolation | 10 | 10 | 9 (reviewed path in place; token for automatic deploys pending: G4) |
| 2 | Functional product and administration | 10 | 9 | 7 (all deployed; not yet used by employees) |
| 3 | Verified knowledge and inventory | 10 | 8 | 2 (identity/phones/links only; no hours, staff, offers or inventory) |
| 4 | Real authorized CRM integration | 15 | 6 | 2 (employee-assisted only) |
| 5 | Live conversation and messaging | 15 | 6 | 1 (no system sending; no live replies) |
| 6 | Sales, Service, Parts, Lead Recovery | 10 | 8 | 2 (Assist enabled; no real leads worked) |
| 7 | Five-store operational isolation | 5 | 5 | 3 (isolation tested; stores not operating) |
| 8 | Communication compliance and trust | 10 | 9 | 4 (enforced in code; counsel policy and consent not on file) |
| 9 | Security, privacy, DR | 10 | 9 | 8 (dedicated keys set; off-volume/scheduled backups pending) |
| 10 | Monitoring, reporting, cost | 5 | 4 | 2 (report delivery off; model prices not configured) |
| | **Total** | **100** | **74** | **40** |

| View | Score | Basis |
|---|---|---|
| Engineering completeness | **74 / 100** | What is built and tested; external-only work counts as not built |
| Production deployment readiness | **92 / 100** | R4 live; reviewed path in place; open: G4 (deploy token), I1 (off-volume backups) |
| Employee-assisted operational readiness | **45 / 100** | Usable today, but stores lack hours, staff, contacts, offers and inventory, and no employee has used it |
| CRM integration readiness | **15 / 100** | Contracts and tasks ready; no authorized Tekion access |
| Autonomous operational readiness | **5 / 100** | Blocked by policy, consent, CRM access and permits |
| **Overall verified production readiness** | **40 / 100** | Production evidence only |

The path to 100 is external: dealership data (D1–D6), inventory credentials (V1), Tekion (T1), counsel (R7, R11, R12), and the operational evidence that follows.
