# AMQUR — owner handoff (actions Cursor cannot finish)

**Date:** 2026-11-20  
Engineering may continue with flags off. These are the only remaining owner/vendor moves that unblock live capabilities.

## Immediate (inventory)

1. **Ask vAuto / Dial Difference feed ops to drop New+Used exports** into all ten folders under `sftp.dialdifference.com:2022` for `amqur_inventory_reader`.
2. After files appear, tell engineering to re-run the worker diagnostic (or re-run yourself via Railway SSH):
   `AMQUR_SFTP_DIAGNOSTIC=1 node scripts/diagnose-vauto-sftp-readonly.mjs`
3. Keep all four flags **false** until acceptance:  
   `AMQUR_VAUTO_SFTP_ENABLED`, `INVENTORY_SYNC_ENABLED`, `AMQUR_VAUTO_PUBLISH_PRICES`, `AMQUR_VAUTO_PUBLISH_PHOTOS`.

## Before any customer-facing lead

4. Confirm ADF inbound addresses per store with CRM admins.
5. Finish SPF/DKIM/DMARC + relay account for the sending domain.
6. Counsel-approve consent language (EN/ES).

## Before Tekion / booking truth

7. Complete Tekion APC enrolment; provide sandbox credentials and official schemas (never paste secrets into chat/Git).
8. Do not treat sandbox appointment acknowledgements as production confirmations.

## Before website install

9. Approve DealerOn / Apollo installs; keep Dial Difference concierge until AMQUR acceptance.
10. Undraft/merge PRs only after review: backend #55 → widget #29 → group site #13 (order in release runbook).

## Optional quality

11. Provision a scoped staging LLM key for live-model evaluation.
12. Complete manual screen-reader checklist.

## Do not

- Enable publish/sync flags until real feeds pass acceptance.
- Merge draft integration PRs solely to “look finished.”
- Paste SFTP passwords, Railway tokens, or customer PII into GitHub issues/PRs/chat.
