# New client onboarding — website assistant

Repeatable path for a new dealership. Isolation is the default: a new tenant
has no allowed origins, so no website can obtain a token until one is approved.

1. **Register the tenant** — `npm run onboard:dealership` with a config file
   modelled on `config/production-onboarding/*.json`. One tenant per rooftop,
   location slug `main`. Leave `allowedOrigins` empty.
2. **Sandbox first** — create the same tenant on staging and allow only
   `https://staging-widget.dialusnow.com`.
3. **Verify the website origin** — load the dealer's site in a browser; record
   scheme + host exactly. Do not assume `www` equals apex. Record how it was
   verified.
4. **Branding** — `scripts/apply-production-branding.ts` (logo, colours). This
   must not touch origins.
5. **Truth sources** — connect the inventory feed (XML/CSV/JSON over HTTPS;
   FTP is not supported), publish approved knowledge, set hours and department
   contacts. Anything not connected is answered with "not available" plus a
   handoff, never a guess. Keep `inventory` / `knowledge` flags off until the
   source is verified.
6. **Privacy** — set the tenant's consent text; the dealer's counsel approves it.
7. **Add the target** to the widget repo's `docs/release/install-targets.json`
   and run `npm run build:snippets`. CI rejects wildcard, non-https, duplicate
   or path-bearing origins.
8. **Allow the origin** — add the exact origin to the tenant's `allowedOrigins`
   **and** to the API `CORS_ORIGINS`. Prove: approved origin → 201; missing,
   look-alike, staging and other-dealer origins → 403.
9. **Smoke on staging, then production** — the checklist in `FIVE_ROOFTOP_UAT.md`.
10. **Install** — `CMS_INSTALL_RUNBOOKS.md` in the widget repo.
11. **Rollback** — remove the tag, or empty `allowedOrigins`.

Isolation evidence today: unit and e2e suites cover tenant scoping; widget
tokens carry `tenantId`/`locationId` from the server only. A deployed
cross-tenant run for a newly onboarded tenant has not been recorded.

Known gaps for onboarding: no self-serve origin verification (DNS/meta-tag
proof), `allowedOrigins` and `CORS_ORIGINS` are two lists kept in sync by
hand, removing an origin does not revoke tokens already issued (≤4h).
