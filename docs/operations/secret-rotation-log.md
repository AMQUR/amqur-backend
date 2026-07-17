# Secret rotation log

Records rotations without secret material. Values are stored only in
Railway environment variables.

## 2026-07-16 — staging WIDGET_TOKEN_SECRET (initial rotation)

**Reason:** short-lived staging widget tokens had been pasted into terminal
output in a previous session.

**Method:**
- `feat(auth)` commit `241e3eb` introduced a dedicated `WIDGET_TOKEN_SECRET`
  (widget tokens previously shared `JWT_SECRET`).
- A 64-byte base64url secret was generated in-process (node `crypto`) and
  set via the Railway CLI without ever being displayed, logged, or written
  to disk, shell history, Git, or documentation.
- Staging `api` redeployed (running commit `3d86b57` at verification time,
  confirmed via `GET /api/version`).

**Verification (2026-07-16, staging):**

| Check | Result |
|---|---|
| Pre-rotation token accepted before rotation (guarded endpoint) | 403 role-forbidden (signature valid) |
| Same pre-rotation token after rotation | **401 rejected** |
| New widget-token mint, all five tenants, approved origin | **201 × 5** |
| New token signature validity (guarded endpoint) | 403 role-forbidden (signature valid) |
| Unauthorized origin | **403** |

Staff/admin JWTs were unaffected (dedicated secret; `JWT_SECRET` not
rotated — no staff users exist on staging yet).

**Rotation procedure for the future:** generate a new value the same way,
set `WIDGET_TOKEN_SECRET` on the staging/production `api` service, redeploy,
and re-run the five-tenant verification block in
`docs/canary/internal-canary-plan.md`.
