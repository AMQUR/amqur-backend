# AMQUR — engineering 100 readiness

**As of:** 2026-11-20  
**Engineering score (this checkpoint):** **91/100**  
**Production launch status:** **BLOCKED** (external go-live gates remain)  
**Verdict:** `ENGINEERING INCOMPLETE — ACTIONABLE WORK REMAINS`

Honest scoring uses the master prompt rubric. Points require working evidence, not plans. Live vAuto **files** are still absent — that caps the SFTP category below full credit. This is **not** `ENGINEERING 100/100`.

## Scorecard

| Category | Max | Earned | Evidence / gap |
|---|---:|---:|---|
| Architecture and three-repository integration | 8 | 8 | Three repos via draft PRs; staging API+worker both on `17f6254`. |
| SFTP verification and inventory engineering | 14 | 12 | Live auth + host-key MATCH + 10 dirs EMPTY from worker; diagnostic baked; ops SFTP flag surface. **−2:** no real exports → no format/import LIVE credit. |
| AI truth engine and multi-rooftop routing | 15 | 13 | Orchestrator, provenance, five-rooftop E2E on CI. Staging LLM key missing (−2). |
| CRM and appointment engineering | 12 | 10 | ADF outbox ladder + sandbox receipts in PR #55. Live recipients/Tekion APC BLOCKED (−2). |
| Widget and website integration | 10 | 8 | Widget #29 + site #13 CI green; embed gated off. Staging-e2e skipped; manual a11y pending (−2). |
| Security and privacy engineering | 15 | 12 | Host-key fail-closed; flags false; prior security fixes. `npm audit --omit=dev` = 3 high via Prisma→effect (no safe non-breaking fix) (−3). |
| Testing and agent evaluation | 10 | 8 | PR CI green; focused inventory 21/21; ops+sftp 35/35. Live-model holdout blocked (−2). |
| CI/CD, migrations and deployment | 8 | 7 | Staging API verify OK at `17f6254`; worker aligned; deploy script service names fixed. Actions→Railway history still fragile (−1). |
| Observability and recovery | 5 | 4 | Health + version verified; SFTP flag status on CC home. Alert *delivery* proof not demonstrated (−1). |
| Documentation and handoff | 3 | 3 | Ten-feed verification, external deps, owner handoff, QA evidence, install prep. |
| **Total** | **100** | **91** | |

## Completed this session

- Live worker SFTP authentication with pinned host key.
- Ten-feed empty-directory verification matrix.
- Staging-only read-only diagnostic script + Dockerfile COPY + worker bake.
- Command Center Dial Difference SFTP flag/credential presence surface.
- Staging API + worker aligned to `17f625426b2452439f713e65f8a7fc98d46c2f7d`.
- Owner F1 (password) cleared; F3 (files) remains.

## Remaining engineering (in authority)

1. After vAuto files arrive: re-run diagnostic; validate schema; keep publish flags false.
2. Optional: safe dependency upgrade path for Prisma/effect advisory (without `--force` downgrade).
3. Prove at least one staging alert delivery when an authorized channel exists.
4. Do **not** enable sync/publish flags or undraft PRs without owner review.

## Remaining external

See `AMQUR_EXTERNAL_DEPENDENCIES.md` and `AMQUR_OWNER_HANDOFF.md`.

## Release SHAs (current)

| Surface | SHA |
|---|---|
| Backend branch / staging API / worker | `17f625426b2452439f713e65f8a7fc98d46c2f7d` |
| Widget PR head | `7f2de57b6656c383177bee47fad95a7d21885a79` |
| Group site PR head | `631c9dac67e7a564c157c701386c103d0a403947` |

## CI / staging

- Backend #55, widget #29, group #13: draft; CI historically green (widget staging-e2e skipped).
- Staging: Postgres/Redis up; LLM missing; widget healthz ok; API live.
- Safety flags on worker: all four false.
