# External approval register — CRM Workforce

One row per approval that only a person outside engineering can give. Nothing below has been requested on your behalf; "Request" is the exact ask.

| # | Approval | Who gives it | Request | Unblocks | Status |
|---|---|---|---|---|---|
| R1 | Production release of the CRM Workforce (migration + code, everything off) | AMQUR owner | "Approve deploying `feat/crm-workforce` at `<sha>` to backend-production and worker-production per RELEASE_PLAN.md, with no env switch set." | Staff can sign in and use the workspace in production | **Needed now** |
| R2 | Pilot rooftop configuration | Owner + Dial Nissan GM | "Approve switching Dial Nissan to Assist mode with the employee-assisted connection, customer sending off (pilot-setup script, `--apply`)." | Employees start using Mode A at Nissan | Needed after R1 |
| R3 | Staff accounts and roles for the pilot | Dial Nissan GM | Names, roles and rooftop for each employee who will use the workspace | Named access, audit by person | Needed after R1 |
| R4 | Import of real customer exports | Dealer principal (per rooftop) + privacy reviewer | "Authorize uploading Tekion lead exports for `<rooftop>` to AMQUR; fields limited to those in the mapping screen; retention `<N>` days." | `crmWorkforceRealImports` for that rooftop | Not requested |
| R5 | Backup and restore evidence for production Postgres | AMQUR owner / operator | Run the restore drill in `docs/BACKUP_AND_RESTORE.md`; record schedule, retention and result | Prerequisite for R4 (real data) | Open — existing blocker B-11 |
| R6 | Dedicated data key | Operator | Set `CRM_WORKFORCE_DATA_KEY` (≥32 chars, from the vault) on backend-production and worker-production | Workforce data sealed with its own key instead of the shared integration key | Recommended before R4 |
| R7 | Communication policy | Dealership counsel | Approve limits, contact window, consent wording and identity disclosure; give a document reference | Any system send | Not requested |
| R8 | Tekion: agreement review | Dial Auto Group (contract holder) | Does the Tekion subscription agreement permit automated access to the CRM interface? | Mode C decision | Not requested |
| R9 | Tekion: written automation permission, or APC API scopes | Tekion account team | Use `TEKION_PARTNER_REQUEST_TEMPLATE.md`; ask for lead read, conversation read, message send, task/note write, appointment scopes, sandbox and rate limits | Mode C or D | Not requested |
| R10 | Dedicated Tekion identity per rooftop | Each rooftop's Tekion admin | A least-privilege user for the worker, created by the dealership | Mode C | After R9 |
| R11 | Consent basis for outbound contact | Counsel + GM | Which existing customers have valid consent, and the evidence, per channel | Any outbound send | Not requested |
| R12 | Per-workflow autonomy permit | GM + counsel, per rooftop and workflow | The fourteen fields in the permit (account, department, operation, audience, channel, consent, limits, window, escalation, expiry ≤ 90 days) | Level 3 for that one workflow | Not requested |
| R13 | Virtual identities | GMs | Confirm Alex / Sarah / Victoria / James / Ryan and titles | System sends under that name | Not requested |
| R14 | Internal notification channel for reports and alerts | Owner | Which existing channel (email list / chat) may receive internal reports | Scheduled report delivery | Not requested |
