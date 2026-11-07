# AMQUR production dependency remediation — 2026-11-07
**Status:** Isolated security patch in PR #36; not merged to integrated release or production.

## Scope and provenance
- Baseline backend integrated PR #33 `8405645b` reported 6 production npm advisories (5 HIGH + 1 MODERATE) in the advisory database available at test time.
- Isolated security workflow https://github.com/AMQUR/amqur-backend/actions/runs/42401953573 SUCCESS: compatible non-forced lockfile remediation plus explicit transitive `multer@^2.5.0` override.
- Multer GHSA-q7qp-rjg7-q26m affected versions prior to 2.5.0; 2.5.0 is patched: https://github.com/advisories/GHSA-q7qp-rjg7-q26m.
- Audit evidence: `npm audit --omit=dev --audit-level=high` reported `found 0 vulnerabilities` on patched lockfile.
- Compile/typecheck/lint/119 unit suites/955 tests/backend build passed in isolated workflow.
- Remaining development dependency advisories (full npm audit) require future triage and controlled updates; not equivalent to `npm audit --omit=dev`.

## Integration acceptance
- [ ] Green exact-PR #36 CI including disposable PostgreSQL/Redis E2E suites, empty-DB migrations and Docker build.
- [ ] Inspect package-lock diff + overrides for unintended changes and lockfile integrity.
- [ ] Merge PR #36 into PR #33 integration branch **only after** CI succeeds and review is complete.
- [ ] Repeat exact-head integrated candidate CI after merge.
- [ ] Keep production promotion and public activation **NO-GO** until backup restore, delivered monitoring alert, Railway authorization, and human/dealership approval receipts in issue #34.

This document is also the no-`[skip ci]` change that triggers full PR CI after the automated lockfile commit was intentionally tagged `[skip ci]`.
