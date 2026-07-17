# Go / no-go checklist — internal canary → limited pilot

## Must be YES for INTERNAL CANARY (employees)

| # | Criterion | Status |
|---|-----------|--------|
| 1 | Staging API + widget custom domains HTTPS healthy | |
| 2 | Five tenants present; inventory/payments fail-closed | |
| 3 | No secrets in widget IIFE | |
| 4 | Tenant isolation automated tests green (local/CI) | |
| 5 | Truthfulness / anti-hallucination suite green | |
| 6 | Handoff never claims notify without notified/queued | |
| 7 | Bootstrap unavailable after first SUPER_ADMIN (code + staging) | |
| 8 | Backend CI required checks green (or residual documented) | |
| 9 | Widget CI green | |
| 10 | Employee test script executed or scheduled with owner | |
| 11 | Production DNS **not** attached | |
| 12 | PRs **not** auto-merged | |

## Must be YES before LIMITED DEALERSHIP PILOT

| # | Criterion | Status |
|---|-----------|--------|
| A | Owner-provided HTTPS origins for each rooftop | |
| B | Verified phone/address/hours/privacy where customer-facing | |
| C | Staging employee canary results recorded without critical defects | |
| D | AI key present **or** explicit accept of non-LLM fallbacks | |
| E | CRM/handoff routing destination verified **or** durable-local-only accepted | |
| F | Monitoring/error reporting verified (alert delivery) | |
| G | Team Velocity / store approval for staging install package | |
| H | Inventory/payments still fail-closed without verified feeds | |

## Automatic NO-GO

- Any cross-tenant data leak  
- False “staff notified” customer message without durable delivery/queue  
- Secrets in browser bundle or git  
- Destructive migration patterns  
- Production domains attached prematurely  

**Decision:** ☐ NO-GO · ☐ INTERNAL CANARY · ☐ LIMITED PILOT (not public production)

**Approver:** ________ **Date:** ________
