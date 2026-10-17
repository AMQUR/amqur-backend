# Five-store onboarding and approval packets

One packet per rooftop. **Nothing below is invented**: values are either already in the platform (tenant slugs, safe default flags), observed on a public website (labeled OBSERVED — never shown to customers as fact), or **MISSING** (must come from the named party). Machine-readable source: `config/rooftops/registry.json`; live scoring: `docs/FIVE_STORE_SCORECARD.md`.

Common to every store (already built and tested): AI disclosure, emergency shutoff (Command Center → Rooftop settings → Emergency AI controls), staff takeover/handoff inbox, store isolation (five-rooftop e2e suite), request-only appointments, write-only encrypted credit destination, OTD requests without credit applications, manager-only trade offers, spotlights with two-person approval.

## Inventory feed specification (send to vAuto / the store's inventory provider)

- Delivery: HTTPS (preferred, host allow-listed per store) — JSON, XML or CSV; SFTP is not built yet.
- Refresh: at least every 4 hours; full snapshot each time (deletions = sold/removed).
- One feed per rooftop, or one group feed with a rooftop/dealer-code column.
- Required fields (any of the listed names): `vin`; `stock`/`StockNumber`; `year`/`modelYear`; `make`; `model`; `trim`; `price`/`salePrice` (the advertised price, including any mandatory dealer fees the store includes in advertising); `mileage`/`odometer`; condition (new/used/certified); status if available.
- Optional: `msrp`, `bodyType`, `drivetrain`, `transmission`, `fuelType`, `exteriorColor`, features/options list, photo URLs **licensed for display on the dealer's AI assistant**.
- Safety behavior already built: SSRF guard + host allow-list, anomaly rejection (a feed that suddenly drops most vehicles is not applied), last-known-good with freshness labeling (FRESH / DEGRADED / STALE), sold/unavailable vehicles never offered, synthetic data excluded from production reads.

---

## 1. Dial Chevy of Chicago

| Item | Value | Status / owner |
|---|---|---|
| Tenant / location | `dial-chevy-of-chicago` / `main` | configured in onboarding config; production DB state UNVERIFIED (no Railway access) |
| Website | https://www.dialchevy.com | OBSERVED (public site, 2026-10-14) |
| Website provider | DealerOn | OBSERVED — confirm with DealerOn |
| Embed locations | MISSING | Dealership + DealerOn |
| Public identity | "Dial Chevrolet", 6603 S Western Ave, Chicago | OBSERVED — GM to confirm |
| Inventory source / feed ID | MISSING | vAuto / store |
| CRM / DMS / Tekion store ID | MISSING (Tekion use unconfirmed) | Tekion / store |
| Sales / service / parts hours, holidays | MISSING | GM, service manager |
| Sales / service / parts handoff destinations | MISSING | GM |
| Tax / doc fee / government fees, advertised-price fee treatment | MISSING | GM + counsel |
| Appointment policy | MISSING (requests only until confirmed by staff) | Service manager |
| Staff roles (admins, managers, advisors) | MISSING | GM |
| Branding (logo, colors, assistant name) | MISSING | Marketing |
| Approved AI capabilities | MISSING — proposed: chat, handoff, inventory (after feed), payments (after pricing), service/parts requests | GM sign-off |
| Credit application destination | MISSING | Finance director / Tekion |
| Canary testers, rollback owner | MISSING | GM |
| Written release authorization | MISSING | Dealer principal / GM |

## 2. Dial Nissan of Chicago

| Item | Value | Status / owner |
|---|---|---|
| Tenant / location | `dial-nissan-of-chicago` / `main` | onboarding config; production state UNVERIFIED |
| Website | https://www.dialnissan.com | UNVERIFIED — homepage returned 403 to a read-only check |
| Website provider | MISSING | Dealership |
| All other rows | MISSING (same list as Chevy) | same owners |

## 3. INFINITI of Chicago

| Item | Value | Status / owner |
|---|---|---|
| Tenant / location | `infiniti-of-chicago` / `main` | onboarding config; production state UNVERIFIED |
| Website | https://www.infinitichicago.com | UNVERIFIED — 403 to a read-only check |
| Website provider | MISSING | Dealership |
| All other rows | MISSING (same list as Chevy) | same owners |

## 4. Dial Chrysler Dodge Jeep Ram of Chicago (South)

| Item | Value | Status / owner |
|---|---|---|
| Tenant / location | `dial-cdjr-of-chicago` / `main` | onboarding config; production state UNVERIFIED |
| Website | https://www.dialjeep.com | UNVERIFIED — 403 to a read-only check |
| Website provider | MISSING | Dealership |
| Identity note | Must not be confused with the North store; store IDs must be confirmed separately | GM |
| All other rows | MISSING (same list as Chevy) | same owners |

## 5. Chrysler Dodge Jeep Ram of Chicago — North / Jeep of Chicago

| Item | Value | Status / owner |
|---|---|---|
| Tenant / location | `jeep-of-chicago` / `main` | onboarding config; production state UNVERIFIED |
| Website | https://www.jeepofchicago.com | OBSERVED |
| Website provider | Team Velocity (Apollo) | OBSERVED; Apollo pixel saved **disabled** 2026-07-14 |
| Public identity | "Chrysler Dodge Jeep RAM of Chicago", 5950 N Western Ave, Chicago | OBSERVED — GM to confirm vs South |
| Credit application | owner-supplied Tekion candidate link — encrypted in the LOCAL demo DB only, UNVERIFIED link type | BLOCKED on Tekion + written approval; token should be reviewed for rotation |
| All other rows | MISSING (same list as Chevy) | same owners |

---

## Approval sign-off template (one per store)

> I approve AMQUR for **[store]** at **[exact production origins]** with these capabilities: [list]. Verified store data attached (hours, holidays, handoff destinations, tax/fee rules). Canary testers: [names]. Rollback owner: [name]. — Name, title, date.
