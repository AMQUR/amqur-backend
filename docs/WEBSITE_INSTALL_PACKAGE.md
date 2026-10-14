# Website installation package (per rooftop)

**Status: prepared, NOT installed anywhere.** Publication requires (1) the website provider's confirmation of the install method, (2) the dealership's written approval, and (3) that store's release gate in `docs/FIVE_STORE_SCORECARD.md`. Engineering does not publish to dealer sites.

## Artifact

- Script: `https://<widget CDN host>/amqur-widget.iife.js` — the exact versioned URL is produced by the widget release job (`release.json`); production CDN host to be confirmed at release.
- Size (2026-10-14 build): 271.3 KB raw / 83.6 KB gzip, one request, `defer`-loaded, rendered inside an open-mode Shadow DOM, which isolates its styles (host CSS cannot restyle it; verified by the Playwright "hostile host CSS" test).
- No cookies set by the widget. `localStorage` holds, per store: the signed, tenant-bound conversation id, saved and compared vehicle VINs, and a proactive-prompt dismissal timestamp. No contact details are stored in the browser.
- Network: only the AMQUR API host (`/api/public/widget-config`, `/api/public/widget-token`, `/api/chat`, `/api/public/store-status`).

## Snippet

```html
<script src="https://WIDGET_CDN/amqur-widget.iife.js" defer></script>
<script>
  window.addEventListener('DOMContentLoaded', function () {
    window.AMQUR.init({
      apiBaseUrl: 'https://API_HOST',
      tenantSlug: 'TENANT_SLUG',
      locationSlug: 'main'
    });
  });
</script>
```

| Rooftop | tenantSlug | Production origins (must be in `Tenant.allowedOrigins`, exact match) | Provider (observed) |
|---|---|---|---|
| Dial Chevy of Chicago | `dial-chevy-of-chicago` | https://www.dialchevy.com, https://dialchevy.com (UNVERIFIED) | DealerOn (observed) |
| Dial Nissan of Chicago | `dial-nissan-of-chicago` | https://www.dialnissan.com, https://dialnissan.com (UNVERIFIED) | unknown (site returned 403) |
| INFINITI of Chicago | `infiniti-of-chicago` | https://www.infinitichicago.com, https://infinitichicago.com (UNVERIFIED) | unknown (403) |
| Dial CDJR of Chicago (South) | `dial-cdjr-of-chicago` | https://www.dialjeep.com, https://dialjeep.com (UNVERIFIED) | unknown (403) |
| Jeep of Chicago (North) | `jeep-of-chicago` | https://www.jeepofchicago.com, https://jeepofchicago.com (UNVERIFIED) | Team Velocity / Apollo (observed; pixel saved DISABLED) |

## Requirements for the site

- CSP (if present): `script-src` must allow the widget CDN host; `connect-src` must allow the API host.
- Install **once** per page via one method only (Apollo pixel **or** GTM **or** site script — never two; duplicates create two launchers).
- Do not remove or alter existing GA4, Google Ads, Meta Pixel, Microsoft UET, OEM or site analytics tags. The widget does not fire any third-party analytics.
- Existing chat widgets: decide with the dealership which stays; two chat launchers confuse customers.

## Verification after install (per store)

1. Real URL loads; one launcher; correct store name/branding.
2. `widget-config` returns that store's slug; no other store's data.
3. Ask for a stocked model — results are the store's live inventory; **no "Demo vehicle" badges**.
4. Handoff request appears in that store's Command Center inbox; staff reply reaches the customer.
5. Lighthouse/LCP before vs after within budget (target: no measurable LCP regression; widget loads after `DOMContentLoaded`).
6. Kill switch: Rooftop settings → Turn AI off → widget stops answering for that store only.

## Rollback / removal

- Immediate (no site access needed): Command Center → Emergency AI controls → **Turn AI off** for that store.
- Full removal: disable the Apollo pixel / pause the GTM tag / remove the two script tags; then remove the origins from `Tenant.allowedOrigins` so the API refuses tokens for that site.
