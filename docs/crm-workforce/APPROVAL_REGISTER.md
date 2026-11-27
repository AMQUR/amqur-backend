# Approval register — AMQUR CRM Workforce

**Consolidated 2026-11-25.** This is the single list of decisions that engineering cannot make. Completed approvals are recorded and are never asked again. Nothing here has been sent to anyone outside AMQUR; requests that go to third parties are drafted for the owner to send.

Approval types: **Owner** · **Dealer principal** · **GM** (per store) · **Privacy** · **Counsel** · **Tekion** · **Infrastructure** (owner, with cost) · **Third-party technical**.

## Completed

| ID | What was approved | By | When | Result |
|---|---|---|---|---|
| R1 | Production release of CRM Workforce (everything off) | Owner | 2026-11-25 | `0b8e7e3` live |
| B1 | Non-destructive production backup + isolated restore rehearsal | Owner | 2026-11-25 | Done; repeated before each release |
| R2 | Nissan pilot in Assist mode | Owner | 2026-11-25 | Done |
| A1 | Create the owner's administrator accounts (owner typed the password) | Owner | 2026-11-25 | ADMIN at all five stores |
| R2b | Assist mode at all five stores; sending, imports and CRM access off | Owner | 2026-11-25 | Done |
| R15 | Release 2 (administration, migration `20261126090000`) | Owner | 2026-11-25 | `a08e49e` live |
| R16 | Owner GROUP_ADMIN membership | Owner | 2026-11-25 | Granted, audited |
| R17 | Release 3 (key rotation, evaluation set, contracts) | Owner | 2026-11-25 | `89e598d` live |
| R18 | Release 4 (shared knowledge, inventory lookup, offboarding, privacy coverage, report scheduling; migration `20261127090000`) | Owner | 2026-11-26 | `b8cc6fa` live |
| K2 | Dedicated data and hash keys | Owner | 2026-11-26 | Set in Railway (API + worker), never displayed |
| G1–G3 | Reviewed release path: #56 → integration, deploy.yml retargeted with lineage guard (#57), main protected, #55 → main | Owner | 2026-11-26 | `main` = `62be8d0` contains production; see RELEASE_GOVERNANCE.md |

## Open — needed now (internal, no third party)

| ID | Exact permission requested | Responsible | Store | System / operation | Money | Limits / expiry | Risk | Rollback | Unlocks |
|---|---|---|---|---|---|---|---|---|---|
| **K1** | Keep copies of the keys outside Railway: (a) move the backup passphrase into your password manager and delete `.local-secrets/prod-db-backup-20261125.key`; (b) from the Railway dashboard, copy `CRM_WORKFORCE_DATA_KEY` and `CRM_WORKFORCE_HASH_KEY` (backend-production) into the same vault | Owner (you) | — | your vault | none | — | losing the only copy makes backups unreadable | — | Safe key custody |
| **G4** | Create a Railway workspace token covering `amqur-platform-staging` and set it as GitHub secret `RAILWAY_API_TOKEN`; re-run the Deploy workflow | Owner (you) | — | Railway + GitHub | none | rotate yearly | low; staging deploy of code identical to production | revert the secret | Reviewed deploys from `main` (staging automatic, production on your approval) |
| **R14** | Internal report destination: which channel (e-mail via existing Resend, or an internal chat webhook), which recipients (staff only), and the schedule (default 07:30 / 12:30 / 18:30 daily, Mon 08:00 weekly, Chicago) | Owner | per store or group | Worker; `CRM_WORKFORCE_REPORT_*` | none (existing Resend) | revocable any time | low: counts only, no customer data | unset `CRM_WORKFORCE_REPORTS_ENABLED` | Scheduled reports + critical alerts |
| **I1** | Create one Railway Bucket plus a daily cron service from `ops/offsite-backup` (already built and tested) (read-only DB role, encrypted dumps, 30 daily + 12 monthly kept) | Owner | — | Railway `amqur-platform-staging` | Railway storage per GB-month for ~10 MB; check the price in Railway | review yearly | low | delete bucket and job | Off-volume backups, 24 h RPO |
| **I2** | Decide on a Railway plan that enables native volume backups (optional if I1 is done) | Owner | — | Railway billing | plan difference, per Railway's price page | — | — | downgrade | Point-in-time recovery |

## Open — store data that only the dealership has

| ID | Exact request | Responsible | Store | Where it is entered | Unlocks |
|---|---|---|---|---|---|
| **D1** | Weekly store hours, sales/service/parts hours, and holiday hours (Thanksgiving 26 Nov, Christmas Eve/Day, New Year's Eve/Day) | GM of each store | each of five | Rooftop settings → Hours, then "I verified" | Concierge and agents can state hours |
| **D2** | Department managers and escalation contacts (name, role, work e-mail/phone) | GM | each | CRM Workforce → Store knowledge | Escalations reach a named person |
| **D3** | Staff directory (salespeople, advisors, parts) and accounts for those who will use the workspace | GM | each | Store knowledge + Team → Invite | Named ownership, staff use |
| **D4** | Current approved offers/specials and manufacturer programs with end dates and disclaimers | GM + compliance | each | Spotlights → approve | Agents may mention offers |
| **D5** | Customer policies the agents may state (e.g. pricing disclaimer, appointment policy) | GM / counsel | each | Store knowledge → Policy | Agents state policy accurately |
| **D6** | Confirm or replace the virtual identities: Alex (Chevy, Virtual BDC Manager), Sarah (Nissan, Virtual BDC Manager), Victoria (INFINITI, Virtual Client Concierge), James (CDJR South, Virtual BDC Manager), Ryan (Jeep North, Virtual BDC Manager). Each must not match a real employee | GM of that store | each | AI workforce → identities | Use of the identity in any system message |

## Open — inventory (third-party technical)

| ID | Exact request | Responsible | Unlocks |
|---|---|---|---|
| **V1** | Read-only SFTP account `amqur_inventory_reader` on the Dial Difference SFTPGo host (host, user, password, host-key fingerprint), delivered through a secure channel, then set `AMQUR_VAUTO_SFTP_*`, `AMQUR_VAUTO_SFTP_ENABLED=true` and `INVENTORY_SYNC_ENABLED=true` on API and worker | Owner + the operator of the vAuto/SFTPGo host | All ten feeds (new + used × five stores) into the shared inventory; Google VLA feeds unaffected |
| **V2** | Decide whether feed prices may be shown (`AMQUR_VAUTO_PUBLISH_PRICES`), per store, after compliance review of advertised-price rules | GM + counsel per store | Verified price statements |

## Open — CRM, messaging and autonomy (counsel / Tekion / dealer)

| ID | Exact request | Responsible | Store | Unlocks |
|---|---|---|---|---|
| **T1** | Send the Dial Auto Group authorization letter and AMQUR's APC request (`TEKION_REQUEST_PACKET.md`, track 1) | Owner / dealer principal sends | all five | Sandbox → live Tekion read, webhooks, native send, tasks, appointments |
| **T2** | Counsel reviews the Tekion subscription agreement (track 2) | Dial counsel | — | Decision on browser method |
| **T3** | Only if T1 is slow: written permission for a dedicated browser user (track 3) | Dealer principal → Tekion | per store | Authorized browser worker |
| **R4** | Authorize importing Tekion CSV exports for a named store, with fields limited to the mapping screen and a retention period | Dealer principal + privacy reviewer | per store | Real lead imports |
| **R7** | Counsel-approved communication policy (contact window, frequency, wording, identity disclosure) with a document reference | Dealership counsel | per store | Any system-sent message |
| **R11** | Consent basis per channel for the customers to be messaged, with evidence | Counsel + GM | per store | Outbound messages to those customers |
| **R12** | Per-workflow autonomy permit (all fields; maximum 90 days) | GM + counsel | per store, per workflow | Controlled autonomy for that workflow |

## Retired entries

| Old ID | Why |
|---|---|
| R3 (staff accounts via API) | Replaced by the invite screen (D3) |
| R5 (backup evidence) | Done (B1) and superseded by I1/I2 for schedule and off-volume storage |
| R6 (dedicated data key) | Superseded by K2 |
| R8–R10 (Tekion) | Superseded by T1–T3 |
| R13 (identities) | Superseded by D6 |
