# AI Assistant — release receipt

**No release was performed on 2026-11-18.** This file records the standing
state so the next real release has a baseline. It is not signed off by anyone.

| Component | Production | Staging |
|---|---|---|
| API | `1ff54206573eced6d9cdfb85ca8884010e29b004`, release `39097551581-1`, health ok, `llm: missing` | `8405645b5e9cb966e1ece41ac7cbe66b6987fb3b` (not on `main`) |
| Worker | not verified | not verified |
| Widget / CDN | `2b3a4b47b36cd308777ba150bb6773ec16731d82`, release `39097129225-1`; `embed-manifest.json` commit `unknown` | `7e98c7c6dccfd157c2f0d5950046e8aa8500cd6d` (not on `main`) |
| Command Center | ships inside the API image; no separate identity | same |

- Rollback references: the releases above are the current known state. Railway
  deployment IDs were **not** captured (no project access); capture them
  immediately before any release.
- Schema: `main` adds migrations from #39–#49 that production has not run.
  They were reviewed as additive in their PRs; not re-verified against the
  production database.
- Human approver: none. Production environment reviewer (`AMQUR`) was never prompted.
- Live customer actions enabled by this work: none.
- Advertising, CRM writes, customer messages sent: none.
- Dashboards: Railway project `dial-us-now-platform`; GitHub Actions `Deploy` in each repo.

Merged to backend `main` on 2026-11-18, **not deployed**: #52 (`c030bdb`,
deploy diagnostics), #53 (`1f4652d`, widget token hardening), this docs PR.
Open: widget #28 (install kit, draft).
