# Release evidence — Release 4 (shared knowledge and operations), 2026-11-26

| Item | Result |
|---|---|
| Approval | Owner, in chat: "Approve R4 + keys" (R18 + K2) |
| Commit | `b8cc6fa` on `feat/crm-workforce` (PR AMQUR/amqur-backend#56); tag `prod-2026-11-26-crmwf-r4` |
| Lineage guard | `verify-lineage.sh b8cc6fa`: contains production `89e598d` (4 new commits) |
| CI | build-test, e2e-postgres, migrations-empty-db, docker-build, command-center, sbom: all pass |
| Tests | CRM Workforce integration 103/103 (run twice); unit 1,836 pass / 5 skipped; golden evaluation 65/65; script tests 12/12; lint and build clean |
| Staging | `b8cc6fa` on backend-staging and worker-staging; knowledge health, inventory feeds, inventory lookup, report delivery status and preview, access-log refusal for managers, cross-tenant refusal (403), rooftop settings, Command Center |
| Local visual check | Store knowledge screen renders gaps first with their fix locations |
| Backup | `amqur-backups/amqur-prod-pre-crmwf-r4-20261126.dump.enc`, 324,960 B, sha256 `77547133…f3af83a`; full decrypt + `pg_restore` read OK (71 table-data entries). Restore rehearsal of the R3 backup the same day: 1 s, 0 errors, counts match |
| Keys (K2) | Production held 0 sealed values and 0 suppression hashes, so the hash key was made dedicated and random too rather than referencing the integration key. Both 64-character keys were generated straight into Railway, never displayed, and match across API and worker (fingerprints only). Vault key id `1f4065b4`; seal/open round-trip OK; hash key differs from the integration key |
| Production | `/api/version` reports `b8cc6fa` / `crmwf-r4`; health 200; `/cc/` 200; worker started with `DealerKnowledgeModule` loaded |
| Migration | `20261127090000_dealer_knowledge_entries` applied; 0 pending; no existing table altered |
| Five stores | All: `crmWorkforce` on, LOCATION Assist, not halted, sending off, real imports off, `manual_assist` READY. 0 actions executing or sent. Owner group membership intact |
| Knowledge health (production) | Each store: identity, address, three phones, links OK (10 OK, no conflicts); hours, department hours, holiday hours, offers, managers, escalation contacts, staff, policies MISSING (19); inventory BLOCKED (feed credentials). Exactly as expected: the dealerships have not supplied these facts |
| Concierge | Widget config 200 for all five stores; public health and store-status 200; live conversations continue (latest 2026-11-26 03:54 UTC) |
| ADF | `ADF_SEND_ENABLED=true`, unchanged |
| Reports | Delivery off (`CRM_WORKFORCE_REPORTS_ENABLED` unset), awaiting R14 |
| Rollback | Redeploy `89e598d`: compatible; the new table is unused, and no data is sealed with the new key yet. Once data exists, roll forward |
