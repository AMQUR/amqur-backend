# Production completion ledger

Branch: `feat/production-completion-2026-10`  
Checked: 2026-10-15  
Launch scope: Jeep of Chicago North customer webchat and staff workflow. Optional SMS, email, voice, and the other four rooftops stay gated.

States: `NOT_STARTED`, `IN_PROGRESS`, `IMPLEMENTED`, `TESTED`, `STAGING_VERIFIED`, `EXTERNAL_BLOCKED`, `PRODUCTION_VERIFIED`.

Verdict for live customers: **NO-GO**. Engineering for the webchat scope is in the branch. Staging and production cannot be verified from this workspace.

| Workstream | Status | Evidence | External dependency |
|---|---|---|---|
| Conversational safety, OTD disambiguation, VIN-bound payments, trade vs purchase, weather-name tool use | TESTED | Backend `5506d0d`. Unit suite 516 passed. Owner-stress e2e 7 passed. One real Claude replay: 20 composed, 1 repaired, 4 locked drafts, 1 discarded. Safety transcript passed on model wording. | Anthropic key is shell-only; a second live replay was not repeated after the local demo process exited |
| Widget payment card bound to VIN; stale payment hidden | TESTED | Widget `4e063ed`. `cards.test.tsx` 12 passed | None |
| Production model calls without a shared spend counter | TESTED | `4186027`. Router returns `spend_store_unavailable` in production when `REDIS_URL` is missing or Redis is unhealthy. `llm-router.service.spec.ts` 14 passed. Deterministic replies continue | Production Redis must be healthy before Claude runs in production |
| Tenant isolation | TESTED | `tenant-isolation` e2e passed locally on 2026-10-15 against the disposable test Postgres | None for the automated suite |
| Staff handoff record | TESTED | Escalation persisted, `notifiedAt` null, `escalation.create` and `escalation.append` audited when `CRM_WEBHOOK_URL` is unset. Reply says nobody was contacted | B-04 receiving endpoint and owner |
| Live inventory | EXTERNAL_BLOCKED | Adapter, SSRF allowlist, anomaly rejection, and fail-closed customer inventory exist. No authorized feed in this environment | B-02 |
| Tekion CRM, scheduling, RO, parts | EXTERNAL_BLOCKED | Adapter refuses operations until `isLiveConfigured()` | B-01 official spec and sandbox |
| Credit application | EXTERNAL_BLOCKED | Encrypted destination, demo preview only, per-customer issuance fails closed | B-05 |
| Verified hours and store facts | EXTERNAL_BLOCKED | Answers stay unverified until `storeHoursVerifiedAt` | B-03 |
| Tax, doc fee, OTD dollars | EXTERNAL_BLOCKED | Illustrative policy excludes taxes and fees; no invented Illinois rate | B-06, B-18 |
| Sports scores | IMPLEMENTED | `LiveInfoService.sports()` returns unavailable. No result is stated | A licensed provider would be a new contract (not purchased) |
| Weather | IMPLEMENTED | National Weather Service, Chicago-area places only. A name containing "weather" does not call it | None |
| SMS, email, voice | EXTERNAL_BLOCKED | Consent and outbox plumbing exist. No live send | B-07, B-08, B-09 |
| Uploads in production | IMPLEMENTED | `UPLOAD_STORAGE=local` throws `uploads_storage_not_configured` when `NODE_ENV=production` | B-13 bucket choice |
| Production boot secrets | IMPLEMENTED | `CORS_ORIGINS` and `INTEGRATION_ENCRYPTION_KEY` are required when `NODE_ENV=production` | B-15 confirmation on the Railway service |
| Backups and restore drill | EXTERNAL_BLOCKED | Not observable from here | B-11, B-19 |
| Error monitoring delivery | EXTERNAL_BLOCKED | Sentry instrumentation exists. No DSN confirmed and no alert receipt | B-12 |
| Staging deploy and runtime SHA | EXTERNAL_BLOCKED | `railway whoami` on 2026-10-15: `invalid_grant` | B-19 owner re-login |
| Website installation | EXTERNAL_BLOCKED | Not performed | B-10, B-14, B-20 |
| Employee canary and public traffic | EXTERNAL_BLOCKED | `CANARY_EMPLOYEE_ENABLED` defaults false | B-14 |

## Git

Local commits not on the pull requests at the start of this pass:

- Backend `5506d0d` then `4186027` (ahead of previous PR head `ab06ca3`)
- Widget `4e063ed` (ahead of PR head `aaddf35`)

Pull requests, still open, not merged:

- https://github.com/AMQUR/amqur-backend/pull/28
- https://github.com/AMQUR/amqur-widget/pull/21

CI on those older heads was green. CI for the new heads starts only after they are pushed. Feature-branch pushes are not in the workflow `push` filters; pull-request synchronize is what runs CI.

Uncommitted eval JSON under `backend/test/evidence/` was already dirty and is not part of this release commit. Root `docs/LOCAL_OWNER_DEMO.md` was already dirty on `main` and was not committed.

## Not claimed

No staging SHA, no production SHA, no backup receipt, no monitoring alert, no dealership signature, and no public-traffic approval were observed.
