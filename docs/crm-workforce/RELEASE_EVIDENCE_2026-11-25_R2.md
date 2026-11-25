# Release evidence — CRM Workforce release 2 (administration), 2026-11-25

| Item | Result |
|---|---|
| Approval | Owner, in chat: "Approve both" (release 2 + owner group membership) |
| Commit | `a08e49e` on `feat/crm-workforce` (PR AMQUR/amqur-backend#56). Includes `fd1767f` (features) and `a08e49e` (security fix) |
| CI | build-test, e2e-postgres, migrations-empty-db, docker-build, command-center, sbom — all pass on `a08e49e` |
| Tests | Integration 95/95 (CRM Workforce suite); unit 1,754 pass / 5 skipped; Command Center 47/47 |
| Security review | Finding: group admin could reset another dealership's ADMIN and receive the link (account takeover). Fixed in `a08e49e`: authority capped by home role; cross-dealership staff management limited to roles below ADMIN. Regression test added |
| Staging | `a08e49e` on backend-staging and worker-staging; endpoints, public link pages and cross-tenant refusal (403) checked |
| Backup before migration | Encrypted logical backup in the production Postgres volume: `amqur-backups/amqur-prod-pre-crmwf-r2-20261125.dump.enc`, 321,248 bytes, sha256 `8c4870f1…5d81d8`. Fully decrypted and read by `pg_restore` (70 table-data entries). Key: same vault item as R1 |
| Production deploy | backend-production and worker-production, `/api/version` reports `a08e49e`, release `crmwf-r2`. Health 200, `/cc/` 200 |
| Migration | `20261126090000_crm_workforce_staff_tokens` applied once, not rolled back. No existing table altered |
| Five stores after release | All five: `crmWorkforce` on, LOCATION mode ASSIST, not halted, customer sending off, real imports off, 3 agent profiles, `manual_assist` READY. Zero actions executing or sent |
| Concierge | Website `www.dialdifference.com` 200; no widget or chat route changed |
| Group membership | Owner's Nissan ADMIN account (MFA on) → GROUP_ADMIN in Dial Auto Group (6 tenants incl. the group tenant). Audited |
| Rollback | Redeploy `0b8e7e3`; table `CrmWfStaffToken` is left in place and unused |

Provider status: Tekion BLOCKED · system SMS/email BLOCKED · booking BLOCKED · employee-assisted drafting LIVE (Assist) · staff invitations LIVE (links delivered by hand; no email channel).
