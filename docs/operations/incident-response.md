# Incident response

1. **Detect** — health/alerts/support
2. **Triage** — customer-facing? data integrity? security?
3. **Contain** — disable feature flags / canary kill / scale / rollback
4. **Communicate** — internal + dealer contact; never invent status
5. **Remediate** — fix forward or rollback
6. **Postmortem** — blameless; update runbook

## Kill switches

- Tenant `featureFlags.chat=false` / inventory/payments off
- Widget canary `amqur_canary_kill=1`
- `CANARY_EMPLOYEE_ENABLED=false`
- `INVENTORY_SYNC_ENABLED=false`
- `OUTBOX_PROCESSOR_ENABLED=false` (pause outbound; retain outbox)
