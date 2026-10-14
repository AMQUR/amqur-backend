# Tekion integration

Tekion is the highest-priority dealership-system integration. **No official Tekion partner specification, sandbox, or credentials are available**, so the live HTTP client is intentionally not implemented. Nothing guesses or reverse-engineers Tekion endpoints.

## What exists

| Piece | Location |
|---|---|
| Capability model (`TekionCapabilities`, declared per connection after contract verification) | `src/integrations/tekion/tekion.capabilities.ts` |
| Fail-closed adapter (`TekionNotAuthorizedError` on every call; health `awaiting_vendor_credentials`) | `src/integrations/tekion/tekion.provider.ts` |
| Test-only contract fixture (refuses to construct outside `NODE_ENV=test`) | `tekion.contract-fixture.ts` |
| Writeback gate (flag + enabled + liveReady + `contractVerifiedAt` + https base URL + declared capability + live client) | `src/integrations/crm/crm-sync.service.ts` |
| Durable writeback worker (outbox topic `crm.tekion.lead-sync`, idempotency key per conversation) | `tekion-crm-writeback.service.ts` |
| Scheduling adapter slot (`ServiceSchedulingProviderAdapter`) with confirmed/pending/unavailable/failed semantics | `src/appointments/scheduling-provider*.ts` |
| Command Center: status, capability matrix, gate reason, connection environment, credential presence | Integrations page |

## Activation (after B-01 artifacts arrive)

1. Store credentials via the vault (never in Git, never logged).
2. Create `IntegrationConnection { provider: TEKION, capability: crm|appointments, config: { environment: 'sandbox', apiBaseUrl, dealerId, storeId } }`.
3. Implement `TekionHttpClient` from the official spec: OAuth token lifecycle, timeouts, retries only for idempotent operations, pagination/cursor, rate-limit handling (429 → backoff), idempotency keys, correlation + provider request IDs, safe error mapping, sanitized fixtures.
4. Register the scheduling adapter: `SchedulingProviderRegistry.register('TEKION', adapter)`.
5. Run contract tests against the sandbox; then set `contractVerifiedAt`, `contractVersion`, and **only** the capabilities proven, plus `liveReady: true`.
6. Enable `tekionIntegration` for one rooftop; watch Command Center → Integrations and Delivery failures.

## Never log

Access/refresh tokens, client secrets, full customer payloads. Use `redactForLog`.
