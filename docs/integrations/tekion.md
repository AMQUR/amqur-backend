# Tekion integration

## Status
**Adapter + mock implemented. Live integration DISABLED.**

Live API endpoints, auth, and schemas are intentionally not invented.
Enable only after partner credentials and official documentation are supplied.

## Capabilities (mock / contract)
| Capability | Adapter | Live | Notes |
|---|---|---|---|
| Customer upsert | yes | no | Idempotent mock |
| Lead create/update | yes | no | Deduped by idempotency key |
| Activity append | yes | no | Logged only |
| Service appointment request | yes | no | Always `REQUESTED`, never confirmed |
| Repair order status | yes | no | Returns null (never invents) |

## Activation checklist
1. Obtain Tekion partner approval + scopes
2. Set encrypted secrets via `INTEGRATION_ENCRYPTION_KEY` + IntegrationSecret
3. Create `IntegrationConnection` with `provider=TEKION`, `liveReady=true`, `enabled=true`
4. Map location `externalIds` to Tekion store identifiers
5. Verify webhook signature secret
6. Run contract tests against sandbox
7. Flip tenant feature flag `tekionIntegration`

## Endpoints
- Staff: `GET /api/integrations/health`
- Writeback: `TekionCrmWritebackService.syncLead(leadId)` (outbox topic `integration.tekion.lead-writeback`)
