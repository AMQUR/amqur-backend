# Local owner demo — runbook

Everything here runs on your machine against the **disposable** Docker test stack
(`docker-compose.test.yml`: Postgres :55432, Redis :56379). Nothing touches Railway, staging or
production. Every seed and operator script refuses a non-local `DATABASE_URL`.

## What is real vs. simulated

| Area | In the demo | Source of truth in production |
|---|---|---|
| Conversation, intent understanding, memory, payment math, request records | **Real code**, deterministic | same |
| Inventory (8 vehicles: 3 Grand Wagoneer, 2 Wrangler, Compass, Grand Cherokee, Gladiator) | **SIMULATED** — `source=synthetic_demo`, badged "Demo vehicle", VINs contain the letter O (impossible in a real VIN), no photos | Authorized feed (B-02); production reads exclude synthetic rows |
| Store hours | **Synthetic**, labeled "demo hours" in the header, storefront and replies | Staff-verified hours (B-03); production treats synthetic hours as unverified |
| Prices | Synthetic figures, not any dealership's advertised prices | Feed price |
| Payment estimates | Real calculation, illustrative 7.9% APR, taxes/fees excluded (labeled) | Dealer-verified policy (B-06) |
| Out-the-door | Request is recorded and routed to staff; no total is shown because tax/fee rules are not verified | Itemized estimate appears only once tax, doc fee, government fees and jurisdiction are verified |
| Appointments | Real `Appointment` **request** rows (status REQUESTED); never "confirmed" | Staff or verified scheduler (B-01) |
| Credit application | Owner-supplied Tekion link, stored **encrypted**, shown as **Demo preview**; click opens an AMQUR interstitial and never navigates to Tekion | Live only after vendor link-type confirmation + dealership authorization (B-05) |
| AI language polish | Off unless you supply a key (below); deterministic replies otherwise | `ANTHROPIC_API_KEY` on the service |

## Start everything

```bash
cd backend && npm run test:infra:up
```

```bash
cd backend && set -a && . ./test-infra/.env.test && set +a && npx prisma migrate deploy && npm run seed:local-demo
```

```bash
cd backend && npm run start:local-demo
```

```bash
cd amqur-widget && npm run dev:demo
```

| App | URL |
|---|---|
| Customer widget (demo dealership) | http://localhost:5173 (click the chat button, bottom right) |
| Command Center (staff) | http://localhost:3001/cc/ |
| API health | http://localhost:3001/api/public/health |

`.claude/launch.json` at the workspace root defines the same two servers (`api-demo`, `widget-demo`).

## Staff login for the Command Center (no credentials in Git)

Choose your own email and a password of 12+ characters, then re-run the seed with them in
your shell only:

```bash
cd backend && set -a && . ./test-infra/.env.test && set +a && DEMO_ADMIN_EMAIL='you@example.com' DEMO_ADMIN_PASSWORD='choose-a-long-password' npm run seed:local-demo
```

Sign in at http://localhost:3001/cc/ with tenant `dial-demo-local`. Admin roles are asked to
enroll TOTP MFA on first sign-in.

## Optional: enable AI language polish locally

The concierge is fully functional without a model. To let the LLM rephrase the server-authored
draft (facts are still enforced by the grounding guard):

1. Create a key in the Anthropic Console (your account; a paid action is yours to take).
2. In **your terminal only**, export it under the demo-scoped name, then start the API:

```bash
read -rs AMQUR_DEMO_ANTHROPIC_API_KEY && export AMQUR_DEMO_ANTHROPIC_API_KEY && cd backend && npm run start:local-demo
```

The start script prints `anthropic=configured|missing` and the model id — never the key.
Default model: `claude-sonnet-5-5` (override with `ANTHROPIC_MODEL`). The id matches the current
Claude model list available to this engineering session; it has **not** been exercised against
the API from here because no key exists in this environment.

Never write the key into `.env.test`, `.env.local` or any tracked file.

## Credit application destination (owner-supplied Tekion link)

Status: **stored encrypted in the local demo DB, link type `UNVERIFIED`, demo preview only.**

- No public Tekion documentation establishes whether a `consumer-credit.tekioncloud.com`
  `?token=…` link is reusable or per-customer. AMQUR does not guess and does not open the link
  to test it.
- To go live (any environment), an admin records the vendor-confirmed link type and the
  dealership's written approval **for that rooftop**:
  - Command Center → Rooftop settings → Secure credit application, or
  - `PUT /api/ops/locations/:id/credit-application/destination` (write-only URL),
    `POST …/authorize { linkType, evidenceRef }`, `POST …/disable`, `GET …/credit-application`.
- Locally, the same lifecycle is available without a browser (URL read from a hidden prompt,
  never argv):

```bash
cd backend && set -a && . ./test-infra/.env.test && set +a && npm run credit:destination -- configure --tenant dial-demo-local --location demo-rooftop --operator you@example.com --link-type UNVERIFIED --demo-preview
```

- Rotating the URL clears the authorization. `PER_CUSTOMER` never distributes a static token
  (an official per-customer issuance API is required; the `CreditLinkProvider` interface exists,
  no implementation until Tekion supplies the contract).
- Because the token was shared in a chat transcript, ask Tekion whether it should be rotated.

## Suggested demo script

1. "Hi" → "How are you?" → "I'm just looking around."
2. "I've been thinking about a Grand Wagoneer." → swipe the cards.
3. "Compare the two nicest ones." → "What if I put $7,000 down?"
4. "I like the Series II." → "What would that be a month?" → "Show me 60 months instead."
5. "What's the out-the-door price?" → "I'm paying cash."
6. "Where's your credit application?" → "Does that mean I'm approved?"
7. "Can you schedule an oil change too?" → "2019 Jeep Cherokee" → "Saturday at 10am"
8. "And I need brake pads." → "Now let's go back to the Grand Wagoneer."
9. Open the Command Center → Service · Parts · Finance to see the appointment, parts, finance and
   out-the-door quote requests the conversation created.

Screenshots of this script at 320/375/390/430/768/1440 px: `docs/evidence/owner-demo/`
(regenerate with `node amqur-widget/scripts/owner-demo-evidence.mjs docs/evidence/owner-demo`).

## Rate limits

The demo API runs with production-like throttles (40 chat turns/min/IP). A person typing never
hits it; scripted runs must pace themselves.
