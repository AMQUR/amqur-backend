# Owner checkpoints — Dial Us Now production

**As of:** 2026-07-18T22:01Z  
Reply with the checkpoint phrase when each item is done so execution can continue.

---

## CHECKPOINT A — Production SUPER_ADMIN (blocking)

Run in your own terminal (interactive password, not echoed):

```bash
cd /Users/saad/Downloads/amqur-platform/backend
API=https://prod-api-production-62be.up.railway.app/api \
RAILWAY_ENV=production \
RAILWAY_SERVICE=prod-api \
./scripts/bootstrap-super-admin.sh
```

Creates tenant `amqur-platform-ops` / role `SUPER_ADMIN`, verifies login+refresh, expects second bootstrap **403**, clears `BOOTSTRAP_SECRET` on prod-api (+ prod-worker), redeploys.

Reply: **SUPER_ADMIN bootstrap complete**

---

## CHECKPOINT B — Production DNS (Squarespace → dialusnow.com)

Add these **exact** records (TTL 300). Do not invent replacements.

| Type | Host | Value |
|------|------|-------|
| CNAME | `api` | `0wcjhs75.up.railway.app` |
| CNAME | `widget` | `t05fw9mw.up.railway.app` |
| TXT | `_railway-verify.api` | `railway-verify=d7f632a8312171eab4502509ea44c2f690f2da148d9cb41ab5812f16517cda8f` |
| TXT | `_railway-verify.widget` | `railway-verify=1789685fc6fb3d723b9481205485beb0762aa96f9fbd7ba9ded7bdcaee137ff5` |

Do not delete staging or email records. Save.

Reply: **DNS production records added**

---

## CHECKPOINT C — Monitoring DSN

Provide/set `ERROR_MONITORING_DSN` on Railway (do not paste into chat/git):

- staging `api` + `worker` (environment tag staging)
- production `prod-api` + `prod-worker` (environment tag production)

Reply: **ERROR_MONITORING_DSN configured** (without the value)

---

## CHECKPOINT D — Backup schedule (Railway dashboard)

For staging Postgres and production `Postgres-RfDb`, confirm and record:

- Snapshot schedule / frequency
- Retention
- Encryption
- Failure notifications

Volumes observed Ready via CLI; schedule itself is dashboard-only.

Reply: **Backup schedules verified** with cadence + retention

---

## CHECKPOINT E — GitHub deploy autopilot

Add repository secret `RAILWAY_TOKEN` to:

- `AMQUR/amqur-backend`
- `AMQUR/amqur-widget`

Configure GitHub Environment `production` with required reviewers.  
Confirm staging environment exists for auto-deploy.

Reply: **RAILWAY_TOKEN and production reviewers configured**

---

## CHECKPOINT F — Human employee canary

1. Open https://staging-widget.dialusnow.com  
2. Follow `docs/canary/employee-test-script.md` (5–15 employees, all five rooftops, ≥100 conversations target)  
3. Record results in `docs/canary/results-template.md`  
4. Complete `docs/canary/go-no-go-checklist.md`

Pass/fail: any hallucination, tenant leak, lost lead, false handoff claim, or auth bypass = **NO-GO**.

Reply: **Employee canary results recorded**

---

## CHECKPOINT G — One pilot rooftop

Select exactly one:

- Jeep of Chicago  
- Dial Nissan of Chicago  
- Dial Chevy of Chicago  
- INFINITI of Chicago  
- Dial CDJR of Chicago  

Provide verified: HTTPS origin (scheme+host only), phone, address, timezone, hours, logo, colors, privacy/terms URLs, handoff process, Team Velocity/GTM approval.

Reply with selection + verified fields (or a secure paste location).

---

## Already cleared (no owner action)

- Local auth + main SHAs current  
- Backend/widget local + e2e validation green  
- Production infra isolation hashes diverge from staging  
- prod-widget staging-HTML leak fixed and redeployed  
- Staging canary host fixed; automated matrix 65/65; Playwright 65 passed  
- Public traffic remains **OFF**
