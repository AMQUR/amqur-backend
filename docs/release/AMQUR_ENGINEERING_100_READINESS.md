# AMQUR — engineering 100 readiness

**As of:** 2026-11-20  
**Source of truth for scores:** `src/release/engineering-scorecard.ts` → `currentEngineeringCheckpoint()`  
**Engineering score (this checkpoint):** **87/100** (sum of categories; validated by unit tests)  
**Production launch status:** **BLOCKED** (external go-live gates remain)  
**Verdict:** `ENGINEERING INCOMPLETE — ACTIONABLE WORK REMAINS`

Do not invent a total. If the displayed total ≠ category sum, the scorecard is invalid.

## Scorecard

| Category | Max | Earned | Evidence / gap |
|---|---:|---:|---|
| Architecture and three-repository integration | 8 | 8 | Three repos + AMQUR Railway workspace ownership reconciled |
| SFTP verification and inventory engineering | 14 | 12 | Live auth; 10 dirs EMPTY; validation/txn/health/alerts path; files waiting (−2) |
| AI truth engine and multi-rooftop routing | 15 | 13 | CI five-rooftop; staging LLM missing (−2) |
| CRM and appointment engineering | 12 | 10 | Sandbox ADF/receipts; live Tekion/ADF external (−2) |
| Widget and website integration | 10 | 8 | #29/#13 draft; embed off; manual a11y (−2) |
| Security and privacy engineering | 15 | 14 | effect@3.22.5 override clears Prisma highs; host-key attestation pending (−1) |
| Testing and agent evaluation | 10 | 8 | Focused+CI; live-model blocked (−2) |
| CI/CD, migrations and deployment | 8 | 7 | Staging redeploy needed for HEAD; Actions token check (−1) |
| Observability and recovery | 5 | 4 | OpsAlertService + metrics; webhook delivery may be unset (−1) |
| Documentation and handoff | 3 | 3 | Ownership, provenance, scorecard, external deps |
| **Total (must equal sum)** | **100** | **87** | 8+12+13+10+8+14+8+7+4+3 |

## Railway migration

See `RAILWAY_OWNERSHIP_RECONCILIATION_20261120.md`. Workspace: **amqur's Projects** (`admin@amqur.com`). Projects transferred intact.

## vAuto SFTP

Verdict unchanged unless re-run for cause: **CONNECTED — WAITING FOR VAUTO FILES**. Flags remain false.

## Remaining controllable work

1. Align staging API/worker SHA to latest HEAD after this commit.
2. Configure `OPS_ALERT_WEBHOOK_URL` on staging and prove one delivery (or leave BLOCKED).
3. Owner host-key attestation for production.
4. External: vAuto files, Tekion, ADF, counsel, CMS installs.
