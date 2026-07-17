# Owner input — verified website origins (required)

Do **not** invent dealership website domains. Until each HTTPS origin is supplied and verified, `allowedOrigins` stays empty and `POST /api/public/widget-token` remains **403** (fail-closed).

Fill the **Owner-provided origin** column with the exact browser `Origin` value (scheme + host, no path), e.g. `https://www.example.com`.

| # | Display name | tenantSlug | locationSlug | Owner-provided HTTPS origin(s) | Status |
|---|--------------|------------|--------------|--------------------------------|--------|
| 1 | Jeep of Chicago | `jeep-of-chicago` | `main` | _PENDING OWNER_ | blocked |
| 2 | Dial Nissan of Chicago | `dial-nissan-of-chicago` | `main` | _PENDING OWNER_ | blocked |
| 3 | Dial Chevy of Chicago | `dial-chevy-of-chicago` | `main` | _PENDING OWNER_ | blocked |
| 4 | INFINITI of Chicago | `infiniti-of-chicago` | `main` | _PENDING OWNER_ | blocked |
| 5 | Dial CDJR of Chicago | `dial-cdjr-of-chicago` | `main` | _PENDING OWNER_ | blocked |

Also provide when ready (still fail-closed until verified):

| Field | jeep | dial-nissan | dial-chevy | infiniti | dial-cdjr |
|-------|------|-------------|------------|----------|-----------|
| Privacy policy URL | | | | | |
| Terms URL | | | | | |
| Store phone | | | | | |
| Address | | | | | |
| Timezone (confirm) | America/Chicago? | | | | |
| Store hours JSON | | | | | |
| Logo URL | | | | | |
| Primary / accent color | | | | | |
| Escalation recipient emails | | | | | |

**Staging canary host (internal only):** `https://staging-widget.dialusnow.com` may be added to `allowedOrigins` **only** for employee canary after owner approval — not a substitute for dealership website origins.
