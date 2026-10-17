# Widget design — Concierge Canvas

One-script embed, Shadow DOM isolation (verified against hostile host CSS in Playwright), React 19 production build: **251.7 KB raw / 78.9 KB gzip** (was 624.6 / 188.5 with the development build).

## States

| State | Behavior |
|---|---|
| Closed | Dealer-colored launcher, accessible label, no intrusive animation |
| Opening (storefront) | Verified open/closed badge (`/public/store-status`; hidden when hours unverified), concise welcome, Sales / Service / Parts tiles, VDP nudge when a VIN is known, composer immediately available |
| Conversation | AI bubbles, staff bubbles (name + accent bar), system events; typing dots while work is in flight; presentation padding ≤2.8 s only after the answer arrives |
| Journey tray | Selected vehicle, estimate, trade, appointment (Requested/Confirmed), credit app, service/parts need, team status |
| Vehicle cards | Real feed photos only (placeholder otherwise), verified price/MSRP, stock, miles, estimate labeled with APR source + tax/fee inclusion, stale/in-transit chips, progressive disclosure (Details, Estimate; ⋯ → test drive, save, compare) |
| Compare | ≤3 vehicles, differing rows emphasized, missing data shown as unknown |
| Status cards | Appointment (REQUEST vs CONFIRMED), credit application (secure external link + no-SSN note), payment estimate, trade (no value), parts (fitment/price/availability verified vs pending), team handoff (notified / in progress / not yet confirmed), hours |
| Staff takeover | AI typing stops; widget polls `/chat/live` and shows staff replies |
| Offline / error | Composer disabled offline; failed sends say "Nothing was saved" with retry; typed text is never dropped |

## Tokens

`--amqur-primary`, `--amqur-accent` (dealer), neutral surfaces `#f6f6f4`/`#fff`, 14px radius, 120–220 ms motion, solid surfaces (no glass), reduced-motion and forced-colors support, 3px focus rings, ≥44px touch targets on mobile, full-screen sheet with safe-area insets ≤480px.

## Page context (privacy-safe)

Explicit `AMQUR.init({ pageContext })` plus public metadata only: canonical path class, schema.org Vehicle JSON-LD VIN/SKU, UTM params, referrer class. Never form fields, cookies, or hidden data. Proactive nudges are contextual (VDP/service), once, dismissal persisted, never over an active conversation.

## Tests

`npm test` (42 unit) · `npx playwright test e2e/local` (journey, keyboard/SR semantics, mobile sheet, Shadow DOM isolation, reduced motion; Chromium/Firefox/WebKit/Pixel 7/iPhone 14) · visual baseline `e2e/local/concierge.spec.ts-snapshots/`.
