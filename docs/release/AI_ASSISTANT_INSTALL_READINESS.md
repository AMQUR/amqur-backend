# AI Assistant — install readiness

**Verdict (2026-11-18): NOT READY TO INSTALL ON EVERY WEBSITE.**

Every row is evidence for the commit and environment named, nothing more.
PASS = observed. FAIL = observed failing. BLOCKED = cannot be exercised until
the named action happens. NOT BUILT = no implementation exists.

## Deployed state (read from the live services, 2026-11-18 ~21:07 UTC)

| Service | URL | Reports | Is `main`? |
|---|---|---|---|
| prod API | `api.dialusnow.com/api/version` | `1ff5420`, release `39097551581-1`, built 2026-10-18 | No — 38 days behind; none of #39–#50 |
| prod widget | `widget.dialusnow.com/version.json` | `2b3a4b4`, release `39097129225-1` | Yes (widget `main`) |
| staging API | `staging-api.dialusnow.com/api/version` | `8405645`, release `phase1-rc-8405645` | **No — commit is on unmerged PR #33's branch, not on `main`** |
| staging widget | `staging-widget.dialusnow.com/version.json` | `7e98c7c`, `phase1-rc-7e98c7c` | **No — unmerged widget PR #24's branch** |
| worker (both) | — | not observable without Railway access | unknown |

Health: both APIs `database: up`, `redis: up`. Production reports **`llm: missing`**; staging `llm: configured`.

`main` heads: backend `e36b94c`, widget `2b3a4b4`.

## Gates

| # | Gate | Status | Evidence / action |
|---|---|---|---|
| 1 | Staging deploy of backend `main` | **FAIL** | Deploy runs `44296005232` … `44397745247` (11 consecutive) fail at "Sync missing worker boot vars": `could not read Railway variables`. Last green: `39097551581` (2026-10-18). |
| 2 | Root cause of #1 known | **BLOCKED** | Script discards the error. PR #52 (CI green, unmerged) prints a category. Facts: one repo secret `RAILWAY_API_TOKEN`, last set 2026-08-10, no environment override; `railway variables` flags identical in CLI 5.70/5.75; an invalid token fails the same way in similar time. A rejected token is the leading explanation, **not proven**. |
| 3 | Railway read access for verification | **BLOCKED** | Connected Railway account returns "You don't have the required role (viewer)" on project `3bca40b6…`. Deployment IDs, worker state, variable names, pgvector: unverified. |
| 4 | Backend CI on `main` | PASS | CI success on `e36b94c` (all jobs). |
| 5 | Widget CI on `main` | PASS (as of #21) | lint, vitest, build. Playwright job `staging-e2e` is skipped on PRs. |
| 6 | Production origin allowlists | **BLOCKED (owner)** | `POST /api/public/widget-token` → 403 for all six tenants for every origin tried: no tenant has any allowed origin. Correct fail-closed state; nothing can be installed until origins are approved. |
| 7 | Production API CORS for dealer sites | **BLOCKED (owner)** | Provisioning script sets `CORS_ORIGINS` to the widget host only; value not readable (#3). |
| 8 | Production LLM configured | **FAIL** | `/api/health` → `llm: missing`. |
| 9 | Six verified website origins | PARTIAL | `www.dialchevy.com` (DealerOn) and `www.jeepofchicago.com` (Team Velocity) verified by HTTP. Nissan, INFINITI, CDJR South, group: hostnames from the group site's own links, but each answers automated requests with 403, so www/apex and CMS are unconfirmed. |
| 10 | Staging run per rooftop | **BLOCKED** | Staging is not `main` (see table); its `embed.js` targets the production API. Five rooftop tenants exist on staging and mint tokens for `https://staging-widget.dialusnow.com`. |
| 11 | Staging run for group site | **BLOCKED** | `dial-auto-group` does not exist on staging (404). |
| 12 | Group store selector | **NOT BUILT** | Group tenant has one location and a welcome message; no routing to a rooftop's inventory. |
| 13 | Streaming (SSE), stop/regenerate | **NOT BUILT** | Chat is request/response plus `/chat/live` polling. |
| 14 | Tekion ADF/XML lead delivery | **NOT BUILT / gated off** | No ADF builder; Tekion provider `isLiveConfigured()` returns false. Leads go to a signed JSON webhook only if `CRM_WEBHOOK_URL` is set. |
| 15 | Widget token security | PARTIAL | Fail-closed origin check PASS in production. Tenant enumeration (401 vs 403) and no origin binding: fixed in PR #53 (unit tests green, unmerged, undeployed). No token revocation. |
| 16 | Customer voice / uploads | NOT BUILT | Staff-only uploads behind a flag; voice provider disabled. Not an install blocker. |
| 17 | Spanish | PARTIAL | `en`/`es` accepted and detected; not gated by the `multilingual` flag; no reviewed Spanish golden set. |
| 18 | Golden truth corpus on release SHA with a real model | **NOT RUN** | Deterministic suites exist (≈66 eval cases, 12 golden conversations, 15 journeys) and pass in CI; no record of model-exercised runs for `e36b94c`. |
| 19 | Browser/a11y matrix, load, 30-min soak on staging | **NOT RUN** | Blocked by #1/#10. |
| 20 | Production release with reviewer approval | **BLOCKED** | `production` environment requires reviewer `AMQUR`; never reached because staging fails first. |
| 21 | Install kit + six snippets | PREPARED, UNTESTED | Widget PR #28 (draft). No snippet has run on its real origin (#6). |

## Feature flags

Default ON: `chat`, `leadCapture`, `handoff`. Everything else default OFF,
including `inventory`, `knowledge`, `multilingual`, `tekionIntegration`,
`appointments`, `uploads`. `KNOWLEDGE_EMBEDDINGS_ENABLED`,
`TOOL_REGISTRY_ENABLED`, `TOOL_DISPATCH_ENABLED` are OFF. Per-tenant flag
values in production were not read (#3).

## Owner actions, in order

1. Merge backend PR #52, let Deploy run, read the printed `category=`.
2. If `UNAUTHORIZED`/`FORBIDDEN`: create a Railway account- or
   workspace-scoped token with access to `dial-us-now-platform` and save it as
   the `RAILWAY_API_TOKEN` repository secret in **both** `amqur-backend` and
   `amqur-widget` (GitHub → Settings → Secrets → Actions). Do not share it anywhere else.
3. Decide what staging should run: today it runs unmerged PR branches
   (#33 backend, #24 widget). Either merge those or let `main` replace them.
4. Give the Railway account used for verification viewer access to the project.
5. Approve the exact website origins (table in the widget repo's
   `docs/release/WEBSITE_EMBED_INSTALL_KIT.md`) — one site at a time.
6. Configure the production LLM provider key.
