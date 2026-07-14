# Secure employee canary authorization

## Problem

A client-writable cookie such as `amqur_emp=1` must **never** be the sole authorization boundary for the Jeep of Chicago employee canary.

## Design

1. Staff (`SUPER_ADMIN` / `ADMIN`) calls `POST /api/canary/invites` with tenant/location (+ optional tester label).
2. Backend stores a one-time `CanaryInvite` (`jti`) and returns a short-lived signed **invite JWT** (not committed, not placed in Apollo/GTM).
3. Authorized tester opens a controlled redeem page (staging: `/canary-redeem.html`) and `POST /api/public/canary-redeem` with the invite.
4. Backend verifies signature, expiry, environment, tenant, rooftop, invite not revoked/reused, and **exact Origin** allowlist; marks invite redeemed; sets `HttpOnly; Secure; SameSite=None` cookie `amqur_canary_emp` (session JWT).
5. Loader in `employee` mode calls `POST /api/public/canary-eligibility` with `credentials: 'include'`. Backend verifies cookie + Origin + claims. Fail closed if absent/invalid.
6. For origins listed in `CANARY_STRICT_ORIGINS` (Jeep), `POST /api/public/widget-token` also requires a valid canary session — public browsers cannot mint tokens by Origin alone.
7. Kill switch: set `CANARY_EMPLOYEE_ENABLED=false` (or revoke unused invites).

## Env (staging)

| Variable | Notes |
|---|---|
| `CANARY_EMPLOYEE_ENABLED` | `true` only when redeem/eligibility should work |
| `CANARY_EMPLOYEE_SECRET` | Optional ≥32 chars; else `JWT_SECRET` |
| `CANARY_ENVIRONMENT` | `staging` |
| `CANARY_SESSION_EXPIRES_IN` | default `2h` |
| `CANARY_INVITE_EXPIRES_IN` | default `15m` |
| `CANARY_STRICT_ORIGINS` | `https://www.jeepofchicago.com,https://jeepofchicago.com` |
| `CORS_ORIGINS` | Must include Jeep + staging widget origins (exact; credentials) |

Tenant `allowedOrigins` may include Jeep **only after** this gate is deployed and tested. Staging widget origin remains for labeled host tests.

## Auditing

Invite **issue**, **redeem**, and **revoke** write `AuditLog` rows (`canary.invite.*`) with tenant/location/environment metadata only.  
Never store invite JWTs, session cookies, or signing secrets in audit metadata or application logs.

## Explicit non-goals

- No token in Apollo / static JS / query strings
- No reusable public secret
- No IP-only trust
- No wildcard / reflected CORS origins
- Do not enable Apollo pixel until handoff + business approval also pass

## Regression coverage

See `src/public/canary-auth.service.spec.ts` and `widget-auth.service.spec.ts`:
authorized+Jeep OK; missing credential fail; forged fail; expired fail; wrong tenant/rooftop/env fail; unknown/missing Origin fail; kill switch fail; Jeep strict origin without session fail; redeemed invite reuse fail; audit without secrets.
