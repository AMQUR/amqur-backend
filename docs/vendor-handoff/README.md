# Website vendor handoff (Team Velocity / rooftop CMS)

## Embed contract

```html
<script src="https://CDN/amqur-widget.iife.js" defer></script>
<script>
  window.addEventListener('DOMContentLoaded', function () {
    window.AMQUR.init({
      apiBaseUrl: 'https://API_HOST',
      tenantSlug: 'ROOFTOP_SLUG',
      locationSlug: 'main'
    });
  });
</script>
```

## CSP requirements (host page)

- `script-src` → widget CDN origin
- `connect-src` → API origin
- `img-src` → CDN + dealership image hosts used in inventory photos
- Prefer not blocking Shadow DOM

## Restrictive host testing

Use `amqur-widget/public/vendor-test-host/index.html` (Shadow DOM, delayed load, CSP meta).

## Do not

- Inject API secrets into GTM
- Point production domains at staging inventory fixtures
- Enable canary without employee auth path validated
