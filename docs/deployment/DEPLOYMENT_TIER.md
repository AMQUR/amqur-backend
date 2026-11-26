# Deployment tier

`NODE_ENV` says how Node/Nest should run. Hosted services — staging included — run with
`NODE_ENV=production`, so `NODE_ENV === 'production'` cannot tell the staging service from
production. `DEPLOYMENT_TIER` says which deployment this is. All reads go through one module,
`src/config/deployment-tier.ts`; the resolved tier is shown read-only by `GET /api/version`
(`deploymentTier`).

## Resolution

| `DEPLOYMENT_TIER` | `NODE_ENV` | Resolved tier | Boot |
|---|---|---|---|
| unset | `production` | `production` | ok — exactly the behaviour before this variable existed |
| unset | `test` | `test` | ok |
| unset | anything else | `development` | ok |
| `staging` | any | `staging` | ok |
| `production` | `production` | `production` | ok |
| `production` | not `production` | (`production`) | **fails validation** |
| `development` / `test` | `production` | (`production`) | **fails validation** |
| `development` / `test` | not `production` | as stated | ok |
| anything else | any | (`production`) | **fails validation** |

An invalid combination resolves to `production` inside the helper as well, so a script that never
ran boot validation still fails closed (every sandbox facility refused, and live sending still
requires `NODE_ENV=production`).

## What each tier allows

| | production | staging | development / test |
|---|---|---|---|
| Live ADF lead sending | yes, with every other gate (master switch, `LEAD_DELIVERY_MODE=live`, verified production-enabled `PRODUCTION` route, non-reserved recipient) | **never** | never |
| Sandbox ADF transport (sink / loopback SMTP) | refused (`sandbox_in_production`) | `SANDBOX` routes only; recipient must be a reserved test domain for every transport; sink keeps metadata only when `NODE_ENV=production` | `SANDBOX` routes only |
| `PRODUCTION`-environment route in sandbox mode | n/a | refused (`production_route_in_sandbox`) | refused (`production_route_in_sandbox`) |
| Sandbox scheduler | refused; `SANDBOX_SCHEDULER_ENABLED=true` fails boot | only with `SANDBOX_SCHEDULER_ENABLED=true` **and** the tenant/location `sandboxScheduler` flag **and** an enabled MOCK `appointments` connection | same gates as staging |
| Demo / sandbox seed scripts (`seed:local-demo`, `seed:group-rooftops`, `seed:local-demo:lead-route`, `adf:sandbox-demo`) | refused | allowed (they still refuse a non-local database) | allowed (local database only) |

Staging can therefore exercise the whole lead and booking flow with synthetic tenants and
reserved `*.example.invalid` recipients, and can never hand a lead to a real CRM inbox, book a
real appointment through the sandbox, or count a sandbox acknowledgement as real.

## Setting it

- Production service: leave unset, or set `DEPLOYMENT_TIER=production`.
- Hosted staging service (runs `NODE_ENV=production`): set `DEPLOYMENT_TIER=staging`.
- Local development / tests: leave unset.

Everything else that keys on `NODE_ENV=production` (CORS, required secrets, MFA roles, synthetic
inventory handling, upload storage, rate limits) is unchanged and applies to hosted staging too.
