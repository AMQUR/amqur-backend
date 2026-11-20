# AMQUR — engineering 100 readiness

**As of:** 2026-11-20  
**Engineering score (this checkpoint):** **88/100**  
**Production launch status:** **BLOCKED** (external go-live gates remain)  
**Verdict:** `ENGINEERING INCOMPLETE — ACTIONABLE WORK REMAINS`

Honest scoring uses the master prompt rubric. Points require working evidence, not plans.

## Scorecard

| Category | Max | Earned | Evidence / gap |
|---|---:|---:|---|
| Architecture and three-repository integration | 8 | 7 | Three repos integrated via draft PRs; staging URLs healthy. Worker SHA lag vs API (`b90d6ee` vs `44d843b`) until next worker deploy. |
| SFTP verification and inventory engineering | 14 | 11 | Live auth + host-key MATCH + 10 dirs listed from worker. Pipeline code + 21 unit tests. **−3:** no real files → no format/import LIVE credit; worker image not yet baking diagnostic permanently. |
| AI truth engine and multi-rooftop routing | 15 | 13 | Orchestrator, provenance, five-rooftop E2E on CI. Staging LLM key missing → live-model NOT TESTED (−2). |
| CRM and appointment engineering | 12 | 10 | ADF outbox ladder + sandbox receipts in PR #55 CI. Live recipients/Tekion APC BLOCKED (−2). |
| Widget and website integration | 10 | 8 | Widget #29 + site #13 CI green; embed gated off. Staging-e2e skipped; manual a11y pending (−2). |
| Security and privacy engineering | 15 | 13 | Prior security fixes on branch; host-key fail-closed; flags false. Full re-audit + dependency audit not re-executed this session (−2). |
| Testing and agent evaluation | 10 | 8 | PR CI green; focused inventory tests 21/21. Full local matrix + live-model holdout not re-run (−2). |
| CI/CD, migrations and deployment | 8 | 6 | Staging API at intended SHA; migrations CI job green. Historical Actions→Railway fragility; worker stamp drift (−2). |
| Observability and recovery | 5 | 3 | Health endpoints verified. Alert delivery proof for SFTP/lead not demonstrated this session (−2). |
| Documentation and handoff | 3 | 3 | Ten-feed verification, external deps, owner handoff, QA evidence, install prep updated. |
| **Total** | **100** | **88** | |

## Completed this session

- Live worker SFTP authentication with pinned host key.
- Ten-feed empty-directory verification matrix.
- Staging-only read-only diagnostic script + Dockerfile COPY.
- Evidence JSON under `amqur-backend/docs/evidence/vauto-sftp-20261120/`.
- Owner F1 (password) cleared; F3 remains (files).

## Remaining engineering (in authority)

1. Deploy `worker-staging` with current branch (bake diagnostic; align SHA).
2. Inventory health/alerting polish if gap audit finds missing ops surfaces.
3. Re-run broader test suites after those commits; keep CI green.
4. Do **not** enable sync/publish flags.

## Remaining external

See `AMQUR_EXTERNAL_DEPENDENCIES.md` and `AMQUR_OWNER_HANDOFF.md`.

## Release SHAs (current)

| Surface | SHA |
|---|---|
| Backend branch HEAD / staging API | `44d843bbb34d2acd7f336ee5c49349d9fb3da465` |
| Worker image stamp at verify time | `b90d6eea7bcd62741679e48bb27b2fc7aa6f2d39` |
| Widget PR head | `7f2de57b6656c383177bee47fad95a7d21885a79` |
| Group site PR head | `631c9dac67e7a564c157c701386c103d0a403947` |

## CI / staging

- Backend #55, widget #29, group #13: draft, CI green (widget staging-e2e skipped).
- Staging: Postgres/Redis up; LLM missing; widget healthz ok.
- Safety flags on worker: all four false.
