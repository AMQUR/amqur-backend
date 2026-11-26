# Release evidence — CRM Workforce release 3, 2026-11-25

| Item | Result |
|---|---|
| Approval | Owner, in chat: "Approve release 3" |
| Commit | `89e598d` (includes `af3b5a7` features and `89e598d` guard fix) on `feat/crm-workforce`, PR AMQUR/amqur-backend#56 |
| CI | build-test, e2e-postgres, migrations-empty-db, docker-build, command-center, sbom — all pass |
| Tests | Integration 96/96; unit 1,833 pass / 5 skipped; CRM Workforce unit 191 incl. 63 golden cases and contract tests |
| Security review | Finding: widened availability exemption allowed "If that works for you it's still available". Fixed in `89e598d` (noun-phrase subject + copula only), regression tests added |
| Staging | `89e598d` on backend-staging and worker-staging; smoke check passed; all 15 existing (legacy v1) sealed values open under the new vault |
| Backup | `amqur-backups/amqur-prod-pre-crmwf-r3-20261125.dump.enc`, 324,496 bytes, sha256 `5a13b341…14df73a`; full decrypt + `pg_restore` read OK (71 table-data entries) |
| Production | backend-production and worker-production report `89e598d` / `crmwf-r3`; health 200, `/cc/` 200, worker started; no migration in this release, none pending |
| Sealed data | Production holds no sealed customer values yet (0), so nothing needed re-sealing; vault ready |
| Five stores | All: Assist, not halted, sending off, real imports off, `manual_assist` READY, 3 profiles. 0 actions executing or sent. Owner GROUP_ADMIN membership intact |
| Concierge | `www.dialdifference.com` 200; no widget or chat route changed |
| Rollback | Redeploy `a08e49e` is safe while production holds no `v2` values; after staff start entering customers, roll forward instead |
