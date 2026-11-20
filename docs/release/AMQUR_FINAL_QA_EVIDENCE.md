# AMQUR — final QA evidence ledger

**As of:** 2026-11-20  
Commands and results actually executed in this session unless noted as prior CI.

## This session

| Suite | Command / locus | Result |
|---|---|---|
| SFTP/host-key/lifecycle unit | `npm test -- --testPathPatterns='sftp\|vauto-sftp\|host-key\|dial-difference\|inventory-lifecycle'` in `amqur-backend` | **21 passed** / 6 suites |
| Live SFTP diagnostic | `railway ssh` → `worker-staging` → `AMQUR_SFTP_DIAGNOSTIC=1 node …diagnose-vauto-sftp-readonly.mjs` | **CONNECTED — WAITING FOR VAUTO FILES**; 10/10 dirs EMPTY |
| Host keyscan | `ssh-keyscan -p 2022 -t ed25519 sftp.dialdifference.com` | `SHA256:RB74t0jOln5yBXsa35xeTZgIfpynQSiTKnn0xzHK11Y` |
| Staging API health | `GET https://backend-staging-staging-b699.up.railway.app/api/health` | database up, redis up, llm missing |
| Staging API version | `GET …/api/version` | SHA `44d843bbb34d2acd7f336ee5c49349d9fb3da465`, tier staging |
| Staging widget | `GET https://widget-staging-staging.up.railway.app/healthz` | `ok` |

## Prior CI on integration PR heads (not re-run entire matrix this session)

| Repo | PR | Head | Checks |
|---|---|---|---|
| `amqur-backend` | #55 | `44d843b` | migrations-empty-db, docker-build, e2e-postgres, command-center, sbom, build-test — **SUCCESS** |
| `amqur-widget` | #29 | `7f2de57` | build, sandbox-e2e — **SUCCESS**; staging-e2e **SKIPPED** |
| `dial-auto-group-platform` | #13 | `631c9da` | verify **SUCCESS**; Vercel preview **SUCCESS** |

## Skipped / not claimed this session

| Item | Reason |
|---|---|
| Full `npm run test:all:local` | Long-running; prior CI green on PR head; focused inventory tests re-run |
| Live inventory format/import acceptance | No vAuto files on SFTP |
| Live-model evaluation | Staging LLM key missing (`llm: missing`) |
| Manual screen-reader | Requires human |
| Production deploy | Not authorized |
| Enabling sync/publish flags | Explicitly forbidden |

## Failures observed

None in focused SFTP unit suite. Live SFTP connection succeeded; empty feeds are an external delivery gap, not a test failure.
