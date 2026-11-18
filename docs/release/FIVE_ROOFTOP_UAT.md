# Five rooftops + group site — UAT matrix

Date: 2026-11-18. "Snippet prepared" ≠ "installed on the CMS" ≠ "customer actions enabled".

| Target | Origin | CMS | Tenant on prod | Tenant on staging | Prod token from site origin | Staging end-to-end run | Snippet | Installed on CMS |
|---|---|---|---|---|---|---|---|---|
| Dial Chevy of Chicago | `https://www.dialchevy.com` (apex 301→www, verified) | DealerOn (verified by headers) | yes, config 200 | yes | 403 — no origins configured | not run | prepared | no |
| Dial Nissan of Chicago | `https://www.dialnissan.com` (unconfirmed www/apex) | Team Velocity (unverified) | yes | yes | 403 (tenant has no origins) | not run | prepared | no |
| INFINITI of Chicago | `https://www.infinitichicago.com` (unconfirmed) | Team Velocity (unverified) | yes | yes | 403 (tenant has no origins) | not run | prepared | no |
| Dial CDJR of Chicago South | `https://www.dialjeep.com` (unconfirmed) | Team Velocity (unverified) | yes | yes | 403 (tenant has no origins) | not run | prepared | no |
| Jeep of Chicago (North) | `https://www.jeepofchicago.com` (200, verified) | Team Velocity (verified in page HTML) | yes | yes | 403 — no origins configured | not run | prepared | no |
| Dial Auto Group | `https://www.dialautogroup.com` (unconfirmed) | unverified | yes | **no (404)** | 403 — no origins configured | impossible today | prepared | no |

## What was actually exercised

Production and staging API, read-only, from a command line (not a browser):

- `widget-config` 200 for six production tenants and five staging tenants.
- `widget-token` with `https://unauthorized.example`, with no Origin, with
  another dealer's origin, and with the widget CDN origin → 403 on production
  for every tenant tested (group, Jeep, Chevy).
- Staging: 403 for all of the above; 201 only for
  `https://staging-widget.dialusnow.com` (Jeep, Chevy).
- Unknown tenant → 401 on both (the enumeration issue fixed by PR #53).

## Not exercised (no receipts exist)

No browser session, screenshot, conversation, inventory card, lead, handoff,
unmount check, accessibility pass, or CLS/LCP measurement on any of the six
origins. No cross-rooftop conversation-isolation run against a deployed
environment in this session. Inventory source per rooftop on production was
not inspected.

## To complete this matrix

Per target, after its origin is approved and staging runs `main`: load the
staging snippet on an origin-matched test page, confirm token 201, hold one
sourced conversation, confirm a real vehicle card or a "no verified inventory"
answer, submit one synthetic lead and confirm routing classification, request
a human, call `AMQUR_EMBED.destroy()`, capture console and a screenshot at
desktop and 375 px. Record the widget and API SHAs with each run.
