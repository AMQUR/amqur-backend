# Dealership onboarding package

## Dial Auto Group target (verified rooftops only)

| DealerGroup | Tenant slug | Location slug |
|-------------|-------------|---------------|
| Dial Auto Group (`dial-auto-group`) | `jeep-of-chicago` | `main` |
| | `dial-nissan` | `main` |
| | `dial-chevy` | `main` |
| | `dial-cdjr-of-chicago` | `main` |

Do **not** create a fifth rooftop until legal/display name, domain, and store info are verified.

## Steps per rooftop

1. Collect: legal name, slug, domain(s), phone, address, timezone, hours, logo, consent text, escalation emails
2. Confirm inventory source (vAuto feed URL) and CRM notify path
3. Run idempotent onboarding API/CLI
4. Set `allowedOrigins` to production domains only
5. Enable feature flags only when dependency chains ready
6. Staff UAT on staging → limited pilot

See `checklist.md`, `data-collection.md`, `dial-auto-group.example.json`.
