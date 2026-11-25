# CRM Workforce — operating guide

**Production:** https://backend-production-production-2415eedf.up.railway.app/cc/
**CRM Workforce screen:** https://backend-production-production-2415eedf.up.railway.app/cc/#/crm-workforce

## Before anyone can use it

Two steps that only you can take:

1. **Staff accounts.** Production has none. See "Create the first accounts" below.
2. **Switch a rooftop on.** Every rooftop is OFF until approved. For the Nissan pilot (approval R2), run the pilot-setup script (`NISSAN_PILOT.md`). Until then the screen shows OFF, and only status, stops and settings work.

## Create the first accounts

The platform creates its first administrator once, using a one-time secret:

1. In Railway (project amqur-platform-staging, environment production), set `BOOTSTRAP_SECRET` on `backend-production` to a random value of at least 16 characters. Railway redeploys the service.
2. Create the platform administrator. Replace the angle-bracket values with your own; this creates a separate `amqur-platform` tenant for you:
   ```bash
   curl -X POST https://backend-production-production-2415eedf.up.railway.app/api/auth/bootstrap -H 'Content-Type: application/json' -d '{"secret":"<BOOTSTRAP_SECRET>","tenantName":"AMQUR Platform","tenantSlug":"amqur-platform","email":"<you>","password":"<your password>","firstName":"<first>","lastName":"<last>"}'
   ```
3. Delete `BOOTSTRAP_SECRET` in Railway. Bootstrap also locks itself once a platform administrator exists.
4. With that account's token, create an account for each person at each dealership with `POST /api/users`, passing `tenantId`, `email`, `password`, `firstName`, `lastName`, `role` (`ADMIN`, `MANAGER` or `STAFF`) and, for `MANAGER` and `STAFF`, the rooftop's `locationId`. There is no user-management screen yet.
5. Each person signs in at the Command Center. Under **Multiple dealerships?**, enter the dealership slug: `dial-chevy-of-chicago`, `dial-nissan-of-chicago`, `infiniti-of-chicago`, `dial-cdjr-of-chicago` or `jeep-of-chicago`. Administrators must set up an authenticator app at first sign-in.

**Working across several dealerships:** create your own `ADMIN` account in each dealership tenant with the same email. Choose the dealership at sign-in, and sign out to switch. The platform administrator account sees only its own tenant in the screens.

## Where things are

Command Center → **CRM Workforce**. The tabs:

| You want to | Go to |
|---|---|
| Work today's customers | **Today**: five queues on the left, the customer workspace on the right |
| Enter a customer from Tekion | **Today** → **Enter a customer from the CRM** |
| Get a reply to send from Tekion | Open a customer → **Write a reply** → edit → **Copy** → send it in Tekion → **I sent this in the CRM** |
| Add the customer's answer | In the customer → **The customer replied** → paste → **Add customer message**, then **Write a reply** again |
| Take a customer yourself / hand back | **I'll handle this customer** / **Return to the virtual team** |
| Ask for an appointment, follow-up or CRM note | In the customer: **Appointment** and **Follow-up and notes** |
| See everything waiting on staff | **Appointments and follow-ups**: claim → **Done in the CRM** (appointments need the Tekion reference) |
| Review older leads | **Lead recovery**: queues by situation and age, with "can we contact?" on every row |
| Review drafts the system queued | **Draft approvals** |
| See the agents and their workload | **AI workforce**: the roster, the identities, the playbooks |
| Change an identity (Sarah, Alex…) | **AI workforce** → Virtual identities (administrators) |
| Switch mode (Observe / Assist / Supervised) | **Modes and kill switches** |
| Stop a rooftop now | The red **Stop this rooftop now** button at the top of the page (anyone); **Resume** (managers) |
| Stop one department (Sales, Service, Parts) | **Modes and kill switches** → Kill switches and pauses |
| Pause one salesperson's leads | **Modes and kill switches** → Pause a salesperson's leads |
| Opt-outs and the suppression list | **Compliance** |
| Export or erase one customer's data | **Compliance** → Customer data (administrators) |
| Import a Tekion export | **Data imports**: preview → check mapping → **Import**; **Undo this import** (needs approval R4) |
| Connections and worker health | **CRM connections and workers** |
| Rate replies (training) | **Draft approvals** → Sent → rate; results in **Agent training** |
| Reports and costs | **Performance and costs**: Morning / Midday / End of day / Weekly, plus model cost |
| See what needs attention | **Overview** → Needs attention (managers) |
| Audit trail | **Audit ledger** (managers) |

## Daily routines

**Salesperson / BDC (Assist mode):**
1. Open **Today**.
2. Work **Unanswered customer messages** first, then new leads.
3. For each customer: check the conversation, write a reply, edit it if needed, send it from Tekion, and click **I sent this in the CRM**.
4. If they want a visit, **Request appointment**. Book it in Tekion, then mark the item done with the Tekion reference.

**Manager:**
1. Each morning: **Overview** → Needs attention, then the **Morning** report.
2. Clear **Appointments and follow-ups**: anything open more than an hour, and every "Customer needs a person".
3. Rate a few sent replies under **Draft approvals → Sent**.
4. At the end of the day: the **End of day** report, and model cost under **Performance and costs**.

## Not available yet

| Control | Status |
|---|---|
| Platform-wide emergency stop from the screen | Needs a platform administrator. Use the environment switch instead: set `CRM_WORKFORCE_EMERGENCY_STOP=true` on `backend-production` and `worker-production` in Railway |
| Editing the communication policy | API only (`POST /api/ops/crm-workforce/policy`, platform administrator, counsel approval recorded). No screen |
| Pausing one named agent | Not a separate switch. Pause its department or workflow instead |
| User management | API only |
| Scheduled report delivery | Not built. Reports are on request |
| Sending from the system, reading Tekion, booking | Blocked until Tekion access and the communication approvals are in place |

## Costs

- Each **Write a reply** is one model call through the existing gateway, with a few hundred tokens in and fewer than 100 out.
- Limits: `CRM_WORKFORCE_DAILY_DRAFT_LIMIT` (default 500 per rooftop per day) and `CRM_WORKFORCE_DAILY_BUDGET_MICRO_USD` (off by default; set it before wider use).
- The cost screen shows $0 until model prices are configured on the gateway (`LLM_COST_INPUT_PER_MTOK`, `LLM_COST_OUTPUT_PER_MTOK`).
- No new Railway services were added; the module runs inside the existing API and worker.
