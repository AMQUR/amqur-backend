# Release evidence — Release 5 (live-conversation safety), 2026-11-26

| Item | Result |
|---|---|
| Approval | Owner, in chat: "Approve manual deploy" (Release 5, `5e0d58e`) |
| Commit / tag | `5e0d58e`, tag `prod-2026-11-26-crmwf-r5` (PR AMQUR/amqur-backend#59) |
| Lineage guard | contains production `b8cc6fa` (8 new commits); one additive migration |
| CI / tests | all six checks green; integration 107/107; unit 1,836 passed; golden 65/65; `npm audit` 0 |
| Staging | `5e0d58e` verified before release (migration, endpoints, refusals) |
| Backup | `amqur-prod-pre-crmwf-r5-20261126.dump.enc`, 331,792 B, sha256 `5869f251…4910ef0`; full decrypt + `pg_restore` read (72 table-data entries) |
| Deploy | backend deployment `0489d638` (23:52:43 UTC), worker `9266d8e8` (23:52:48 UTC) |
| Migration | `20261128090000_crm_workforce_reply_cursor` applied; 0 pending |
| Five stores | all Assist, not halted, sending off, imports off; 0 actions sent or executing; ADF on; dedicated keys present |
| Concierge | widget config 200 for all five stores; site 200; live conversations continuing |

## Incident: overlapping production deploy (23:53–23:55 UTC)

Another Claude session working for the owner ("AMQUR agent demo readiness") deployed `6dc3796` (PR #60, merged to `main`) to `backend-production` at 23:53:16. That was 30 s after this release, and its lineage check had run while production still reported `b8cc6fa`.

- `6dc3796` did not contain `5e0d58e`, so for about two minutes the API ran without Release 5 code. The worker was never changed.
- The session stopped before touching the worker. At 23:55:21 it restored the API by redeploying this release (deployment `bd94a9dd`).
- Both container file systems were then checked independently by both sessions: Release 5 present, PR #60 absent.
- **Impact:** none observed. In Assist mode no automated work runs; the R5 column is additive and ignored by older code; no data was written by the CRM Workforce in that window.

**Lessons, now applied:**
1. `/api/version` reports the `APP_COMMIT_SHA` variable, not the running image. It showed `5e0d58e` while the API ran `6dc3796`. Releases are now also confirmed against Railway deployment records and files inside the containers.
2. Sessions deploying to shared environments announce before deploying, and the lineage guard runs immediately before `railway up`, not minutes earlier.
3. A single combined commit `34270c6` (Release 5 plus PR #60, CI green, verified on staging with both builds present) is prepared as the one next production deploy.
