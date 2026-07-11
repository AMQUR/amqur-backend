# Tekion vendor onboarding — Dial Auto Group

**Status:** BLOCKED — no official partner credentials found in Railway staging, macOS Keychain (AMQUR labels), or authorized env stores.  
**Live Tekion:** remains **disabled** (`tekionIntegration=false`, `IntegrationConnection.liveReady=false`).

Do not invent API bases, scopes, or store IDs. Do not scrape Tekion.

---

## Required from Tekion / partner success (store in Railway / Keychain — never Git)

| Item | Secure store label (suggested) | Present? |
|---|---|---|
| Partner approval / MSA | — | NO |
| Official API documentation URL | — | NO |
| Sandbox API base URL | `AMQUR Tekion Sandbox Base` | NO |
| Client ID | Railway `TEKION_CLIENT_ID` | NO |
| Client secret | Railway `TEKION_CLIENT_SECRET` | NO |
| Webhook signing secret | Railway `TEKION_WEBHOOK_SECRET` | NO |
| Dealer group ID | Railway `TEKION_DEALER_GROUP_ID` | NO |
| Permitted scopes list | docs artifact | NO |
| Rooftop ↔ Tekion store map | Location.externalIds | NO |
| Rate limits | docs artifact | NO |
| Webhook endpoint allowlist | ops runbook | NO |

Repo env placeholders (names only): `TEKION_API_BASE_URL`, `TEKION_CLIENT_ID`, `TEKION_CLIENT_SECRET`, `TEKION_WEBHOOK_SECRET`, `TEKION_DEALER_GROUP_ID`, `TEKION_API_VERSION`, plus `INTEGRATION_ENCRYPTION_KEY`.

---

## Sandbox verification sequence (run only after credentials exist)

1. Configure secrets in Railway staging (not production).
2. Encrypt via `INTEGRATION_ENCRYPTION_KEY` + `IntegrationSecret`.
3. Set `IntegrationConnection` TEKION `enabled=true`, `liveReady=true` for **staging tenant only**.
4. Map `Location.externalIds` for `pilot-rooftop`.
5. Verify scopes: customer lookup, lead create, activity, appointment request.
6. Idempotent lead create + duplicate prevention.
7. Activity writeback.
8. Appointment **request** only (never claim confirmed without authoritative response).
9. Service-history / RO status only if scoped — else remain null.
10. Webhook signature validation + replay rejection.
11. Forced outage + circuit breaker.
12. Tenant/location isolation (no cross-store leakage).
13. Confirm no internal-only fields in public widget payloads.
14. Staff `GET /api/integrations/health` shows liveReady healthy.
15. Flip tenant flag `tekionIntegration=true` on staging only.
16. Production Tekion only after sandbox checklist signed off.

---

## Until then

- Keep mock provider + contract tests green.
- CRM path: capture leads in AMQUR DB; optional `CRM_WEBHOOK_URL` if dealership supplies a safe inbox webhook.
- Pilot may proceed on **fixture / authorized vAuto inventory** without Tekion.
