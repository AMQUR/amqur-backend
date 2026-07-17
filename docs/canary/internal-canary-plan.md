# Internal canary plan — Dial Us Now staging

**Date:** 2026-07-16  
**Environment:** `https://staging-api.dialusnow.com` · `https://staging-widget.dialusnow.com`  
**Verdict target:** READY FOR INTERNAL CANARY (employees only)  
**Out of scope:** production DNS (`api` / `widget`), Team Velocity public install, live inventory/CRM vendors

## Goals

1. Prove five rooftop tenants are isolated and fail-closed.
2. Prove durable handoff persistence without false “we notified staff” claims.
3. Prove widget loads from staging CDN-style host without secrets in the bundle.
4. Prove employees can exercise chat safely once origins + admin bootstrap are ready.
5. Collect monitoring/error signals during the canary window.

## Deployed artifacts

| Component | PR | Branch HEAD (local/remote) | Staging deploy note |
|-----------|----|----------------------------|---------------------|
| API / worker | [AMQUR/amqur-backend#22](https://github.com/AMQUR/amqur-backend/pull/22) | `ee72189` (+ canary follow-ups) | Railway CLI deploy; confirm SHA via redeploy after merge-ready commits |
| Widget | [AMQUR/amqur-widget#13](https://github.com/AMQUR/amqur-widget/pull/13) | `9ee7b4d` (+ staging e2e updates) | Serves `assistant-widget.iife.js` |

## Tenants (fail-closed)

| tenantSlug | locationSlug | Inventory | Payments | Widget token |
|------------|--------------|-----------|----------|--------------|
| jeep-of-chicago | main | off | off | 403 until origins |
| dial-nissan-of-chicago | main | off | off | 403 until origins |
| dial-chevy-of-chicago | main | off | off | 403 until origins |
| infiniti-of-chicago | main | off | off | 403 until origins |
| dial-cdjr-of-chicago | main | off | off | 403 until origins |

Owner origins: `docs/canary/owner-website-origins.md`

## Phases

### A — Gate prerequisites (engineering)

- [ ] Backend CI green on PR #22
- [ ] Widget CI green on PR #13
- [ ] Secret scan clean
- [ ] Migrations non-destructive; empty-DB migrate proven locally
- [ ] Bootstrap lockout after first SUPER_ADMIN
- [ ] Staging health: `/api/health` ready (db up), `/api/health/live`
- [ ] Worker online; outbox processor enabled on worker only
- [ ] AI key optional; without it, deterministic/fallback paths only
- [ ] CRM webhook optional; without it, durable escalation only (`notified=false`)

### B — Employee canary window

- [ ] Add approved staging-widget origin **or** temporary canary origin per owner
- [ ] Issue employee canary invites if `CANARY_EMPLOYEE_ENABLED=true`
- [ ] Run `docs/canary/employee-test-script.md` for all five tenants
- [ ] Record results in `docs/canary/results-template.md`
- [ ] Watch API 5xx, latency, Redis degraded, handoff/outbox metrics

### C — Go / no-go

Complete `docs/canary/go-no-go-checklist.md` before any limited rooftop pilot or production DNS.

## Explicit non-goals

- No production domain attach
- No PR auto-merge
- No inventing website domains, hours, prices, inventory
- No Tekion / vAuto enablement
