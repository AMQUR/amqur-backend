# Human handoff readiness — Jeep of Chicago canary

| Check | Status |
|---|---|
| Escalation persisted to DB | READY (code path exists) |
| CRM webhook notify | BLOCKED — `CRM_WEBHOOK_URL` not set on staging/production |
| Verified dealership recipient | BLOCKED |
| Department routing | BLOCKED |
| Business-hour vs after-hours behavior | NOT IMPLEMENTED as schedule-aware routing |
| Escalation SLA | NOT IMPLEMENTED |
| Approved test recipient | BLOCKED |
| Duplicate prevention | READY BUT DISABLED pending live destination test |
| Failure visibility | READY (logs + `notified=false`) |

**Customer traffic rule:** without a verified recipient (email/API) and an approved test send, handoff is **NO-GO for customer traffic**.

When access exists:
1. Store destination in Railway secret / `CRM_WEBHOOK_URL` (or dedicated handoff webhook).  
2. Send **one** approved test payload to a test inbox.  
3. Confirm staff visibility.  
4. Document SLA and after-hours behavior.
