# Local development

One command sets up (and re-verifies) the whole local environment:

```bash
scripts/setup-local-dev.sh
```

It is idempotent and safe to re-run. It:

1. Starts (or creates) the dockerized Postgres container `amqur-postgres-local`
   (postgres:16, `localhost:5432`, user/db `amqur`).
2. Verifies `DATABASE_URL` in `.env.local` points at `localhost`/`127.0.0.1`
   and **refuses to run** against any remote host — local setup can never
   touch Railway staging or production.
3. Runs `prisma generate` and `prisma migrate deploy`, then checks
   `prisma migrate status`.
4. Applies the safe local fixture tenant
   (`docs/onboarding/tenants/local-dev.local.json`):
   - tenant `local-dev-motors` / location `main`
   - `allowedOrigins` limited to `http(s)://localhost` dev ports
   - chat, lead capture, durable handoff on; everything unverified off
   - consent text marks it as a local engineering environment
5. If the API is already running on `:3000`, verifies:
   - `GET /api/public/widget-config?tenantSlug=local-dev-motors&locationSlug=main` → 200
   - `POST /api/public/widget-token` from `http://localhost:5173` → 201
   - `POST /api/public/widget-token` from an unauthorized origin → 403

## Running the API

```bash
npm run start:dev        # watch mode
# or
npm run build && npm start
```

Environment loads from `.env.local` (then `.env`). Never put staging or
production URLs/credentials in `.env.local`.

## Widget against local API

In `amqur-widget/`:

```bash
npm run build
npx serve .   # or any static server on :5173/:8080
```

`test.html` is pre-configured for the `local-dev-motors` fixture against
`http://localhost:3000/api`.

## Troubleshooting

- **P2021 "public.Tenant does not exist"** — migrations were never applied to
  the local database. Run `scripts/setup-local-dev.sh` (it applies them and
  verifies `Tenant`/`Location` exist).
- **Origin 403 from widget-token** — the serving origin isn't in the fixture's
  `allowedOrigins`. Serve on one of the listed localhost ports or edit
  `docs/onboarding/tenants/local-dev.local.json` and re-run the setup script.
- **Release identity** — `GET /api/version` reports version/commit/buildTime/
  releaseId (stamped by `scripts/stamp-release.mjs`; falls back to
  `package.json` in plain local runs).

## Hard rules

- Never run `prisma db push` or destructive prisma commands against staging
  or production.
- Never point `.env.local` at a Railway database. The setup script enforces
  this, but the rule applies to manual commands too.
