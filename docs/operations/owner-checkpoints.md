# Owner checkpoints — Dial Us Now production

## Active checkpoints

### 1. SUPER_ADMIN bootstrap (production)

```bash
cd /Users/saad/Downloads/amqur-platform/backend
API=https://prod-api-production-62be.up.railway.app/api \
  ./scripts/bootstrap-super-admin.sh
```

After production custom DNS is live, use `API=https://api.dialusnow.com/api`.

The script will prompt for email / name / password (password not echoed).  
It must clear `BOOTSTRAP_SECRET` from **prod-api** and **prod-worker** after success.

### 2. Production DNS (Squarespace)

Exact records: `docs/deployment/dialusnow-dns-records.md` (production section).

Reply **DNS production records added** when saved.

### 3. Monitoring DSN

Set `ERROR_MONITORING_DSN` on `prod-api` and `prod-worker` (production environment only).  
Run controlled-error drill; prove alert delivery; then disable the drill.

### 4. Backup schedule

Confirm Railway volume snapshot schedule for `Postgres-RfDb` in the dashboard.  
Record frequency, retention, RPO/RTO in `docs/operations/disaster-recovery.md`.

### 5. Dealership origins

Do **not** add website origins until each HTTPS origin is verified.  
Table: `docs/canary/owner-website-origins.md`.

### 6. Public traffic

Blocked until human canary + monitoring + backups + one rooftop approval.
