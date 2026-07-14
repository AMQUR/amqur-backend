# Human handoff readiness — Jeep of Chicago canary

| Check | Status |
|---|---|
| Escalation persisted to DB | READY (code path exists) |
| CRM webhook notify | BLOCKED — `CRM_WEBHOOK_URL` **ABSENT** on staging (revalidated 2026-07-14) |
| Verified dealership recipient | BLOCKED |
| Department routing | BLOCKED |
| Business-hour vs after-hours behavior | NOT IMPLEMENTED as schedule-aware routing |
| Escalation SLA | NOT IMPLEMENTED |
| Approved test recipient | BLOCKED |
| Duplicate prevention | READY BUT DISABLED pending live destination test |
| Failure visibility | READY (logs + `notified=false`) |
| Synthetic handoff test | NOT RUN |

**Customer traffic rule:** without a verified recipient (email/API) and an approved test send, handoff is **NO-GO**.  
**Apollo enablement rule:** same — keep **AMQUR Internal Employee Canary** disabled until issue #8 closes.

Authorization request (roles + required fields; no secrets):  
`docs/dealership-knowledge/JEEP_OF_CHICAGO_HANDOFF_AUTHORIZATION_REQUEST.md`

When access exists:
1. Store destination in Railway secret / `CRM_WEBHOOK_URL` (never Git/chat).  
2. Send **one** approved synthetic test payload (fake internal data only).  
3. Confirm staff visibility + audit.  
4. Document SLA and after-hours behavior.  
5. Close https://github.com/AMQUR/amqur-backend/issues/8 only after synthetic pass.
