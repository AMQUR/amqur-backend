# Team Velocity handoff — Dial Chevy of Chicago

**Tenant slug:** `dial-chevy-of-chicago`  
**Location slug:** `main`  
**Status:** Staging package ready · Production snippet **NOT APPROVED** until release gate + store approval.

## Staging install (authorized staging host only)

```html
<script src="https://staging-widget.dialusnow.com/assistant-widget.iife.js" defer></script>
<script>
  window.AMQUR.init({
    apiBaseUrl: "https://staging-api.dialusnow.com/api",
    tenantSlug: "dial-chevy-of-chicago",
    locationSlug: "main",
    locale: "en"
  });
</script>
```

## Production install (DO NOT PUBLISH until gate)

```html
<!-- PRODUCTION NOT APPROVED — do not add to live GTM until owner sign-off -->
<script src="https://widget.dialusnow.com/assistant-widget.iife.js" defer></script>
<script>
  window.AMQUR.init({
    apiBaseUrl: "https://api.dialusnow.com/api",
    tenantSlug: "dial-chevy-of-chicago",
    locationSlug: "main",
    locale: "en"
  });
</script>
```

## CSP / allowlist (request from Team Velocity)

| Item | Staging | Production |
|------|---------|------------|
| Script-src host | `https://staging-widget.dialusnow.com` | `https://widget.dialusnow.com` |
| Connect-src API | `https://staging-api.dialusnow.com` | `https://api.dialusnow.com` |
| Frame ancestors | Dealership site origin(s) — **pending verification** | same |

## Still required from dealership / TV (do not invent)

- [ ] Verified website domain(s) for origin allowlist
- [ ] GTM container ID / environment
- [ ] CSP change window + rollback contact
- [ ] Branding assets (logo, colors) if overriding defaults
- [ ] Confirmation chat/lead/handoff only (inventory/payments off)

## Fail-closed capabilities

Inventory, payments, service, parts, appointments remain **disabled** until verified sources exist.
