# Provider contracts

Business workflows depend on contracts, never on vendor SDKs, so CDK, Reynolds, Dealertrack, Xtime, VinSolutions, eLead or vAuto can be added without touching the conversation engine.

| Contract | File | Outcome semantics |
|---|---|---|
| `ServiceSchedulingProviderAdapter` | `src/appointments/scheduling-provider.ts` | `confirmed` (provider booking id) / `pending` / `unavailable` (+alternatives) / `failed` (retryable flag). AMQUR storing a request is never `confirmed`. |
| `CrmProvider` | `src/integrations/core/crm.provider.ts` | External IDs persisted only from provider responses |
| `DmsProvider` | `src/integrations/core/dms.provider.ts` | RO status `null` unless verified |
| `InventoryProvider`, `PartsProvider`, `TradeProvider`, `FinanceProvider`, `MessagingProvider`, `WebsiteContentProvider` | `src/integrations/contracts/provider.interfaces.ts` | verified flags; never invent fitment/price/appraisal/approval |
| Twilio messaging | `src/messaging/twilio.ts` | `SENT` only with provider SID; delivery state only via signed status callbacks |

## Adapter checklist

Tenant/location scoping · capability declaration · credentials from vault · timeout · retry only if idempotent · idempotency key · circuit breaker key `provider:connectionId` · health probe · structured provenance (provider, request id, timestamps) · sanitized error mapping · contract tests with sanitized fixtures · Command Center visibility.
