# AMQUR Command Center

Staff web app in `command-center/` (React 19 + Vite). Built into the API Docker image and served **same-origin** at `/cc/` — no separate deployment, no CORS surface.

## Security

- Strict CSP on `/cc` (`script-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`), `X-Frame-Options: DENY`, `noindex`.
- Access token in memory; rotating refresh token in `sessionStorage` (tab-scoped).
- TOTP MFA (required for roles in `STAFF_MFA_REQUIRED_ROLES`, default `SUPER_ADMIN,ADMIN` in production), recovery codes, sign out of all devices.
- Location-bound STAFF/MANAGER users are locked to their rooftop (server-enforced via `resolveLocationScope`).

## Pages

| Page | API | Notes |
|---|---|---|
| Today | `GET /api/ops/overview` | Attention / engagement vs outcomes / technical / AI quality kept separate; no causal claims |
| Inbox | `GET /api/ops/inbox`, `/ops/conversations/:id`, takeover/transfer/release/reply/notes | Prioritized by reason; AI pauses on takeover; replies require ownership; notes never reach customers |
| Appointments | `/api/appointments` | REQUEST vs CONFIRMED visually distinct; confirm/complete/no-show/cancel are audited |
| Service · Parts · Finance | `/api/ops/queues` | Handoffs (delivery state shown), parts (VIN needed), finance (credit link state), trades |
| Knowledge | `/api/knowledge/*` | Draft → review → approve (manager) → publish; customer-retrieval preview; approved website ingestion |
| Integrations | `/api/ops/integrations` | Tekion capability matrix + writeback gate reason, LLM circuits, channels, monitoring |
| Rooftop settings | `/api/ops/locations/:id/settings` | Hours + explicit verification, holidays, payment policy, credit application allowlist, amenities |
| Delivery failures | `/api/ops/outbox/dead`, `/replay` | DLQ with audited replay |
| Security | `/api/auth/mfa/*`, `/auth/logout-all` | Enrollment shows secret once; recovery codes once |

## Build / run

```bash
npm run build:cc            # from backend/
npm --prefix command-center run dev   # proxies /api to :3001
```
Playwright smoke: `npx --prefix command-center playwright test`.
