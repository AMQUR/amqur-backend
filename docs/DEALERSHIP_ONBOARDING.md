# Dealership onboarding

1. **Tenant + rooftop** — `npm run onboard:dealership` (slugs, timezone, phone, address). Origins: exact production origins only (`https://www.dealer.com`, `https://dealer.com` if both serve the site).
2. **Staff** — create users (role + rooftop binding). Admins enroll MFA on first login.
3. **Rooftop settings (Command Center)** — hours (sales/service/parts), holidays, then click *I verified these hours*. Payment policy (illustrative APR/term; tax+fees only if the dealer verifies). Credit application URL + allowed host. Service amenities (unknown is fine — the assistant will say it can't confirm).
4. **Branding** — `publicConfig`: assistant display name, colors, logo, welcome message, disclaimer, supported locales.
5. **Knowledge** — add FAQs/policies as CUSTOMER visibility, approve (manager) and publish; preview what the AI can retrieve.
6. **Inventory feed** (B-02) — configure, watch the first import (valid/rejected/anomalies), confirm freshness.
7. **Handoff destination** (B-04) — CRM webhook / ADF + signing secret; test escalation end-to-end.
8. **Flags** — enable progressively: `chat`, `handoff`, `leadCapture` → `inventory` → `payments`+`financeCalculator` → `appointments`/`serviceAi` → `partsAi` → `sms` (B-07) → `tekionIntegration` (B-01).
9. **Install** — one script per rooftop:
   ```html
   <script src="https://<cdn>/embed.js" data-tenant="<tenant-slug>" data-location="<location-slug>" async></script>
   ```
   Optional VDP context: `AMQUR.init({ …, pageContext: { pageType: 'vdp', vin: '…' } })`. CSP: `script-src` + `connect-src` for the CDN and API hosts. Remove = delete the tag.
10. **Employee canary**, then public canary with monitoring (Release runbook).
