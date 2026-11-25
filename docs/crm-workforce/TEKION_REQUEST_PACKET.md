# Tekion access — request packet

**Prepared 2026-11-25.** Tekion is the gate for every autonomous capability: reading conversations, detecting replies, sending from Tekion, writing notes and tasks, and booking. Nothing below has been sent. Each request goes out **from Dial Auto Group or AMQUR, by a person**. No Tekion screen, export or API has been accessed.

## Fastest authorized path

Run three tracks at the same time. The first to come back unblocks work. None of them depends on the others.

| Track | Who sends it | To whom | What it unblocks | Typical blocker |
|---|---|---|---|---|
| **1. APC partner API** (preferred) | AMQUR, with a dealer authorization letter from Dial Auto Group | Tekion partner / APC program, through the Dial account manager | Method D: reads, webhooks for replies, Tekion-native send, tasks, notes, appointments | Partner enrollment and certification time |
| **2. Contract check** | Dial Auto Group (contract holder) | Dial's own counsel, using the Tekion subscription agreement | Tells us whether method C is allowed at all | Locating the signed agreement |
| **3. Written browser-automation permission** (fallback) | Dial Auto Group | Tekion account manager | Method C: a dedicated worker using visible Tekion screens | Tekion may refuse; never proceed without it in writing |

Until one track completes, the system keeps running as it does today: employee-assisted (method A), and file exports once approval R4 is given (method B).

## Track 1 — letter from Dial Auto Group authorizing AMQUR (send first)

> To: Tekion account management — Dial Auto Group
>
> Dial Auto Group authorizes AMQUR (contact: [AMQUR contact name and email]) to request and use Tekion Automotive Partner Cloud (APC) access on behalf of the following dealerships: Dial Chevy of Chicago, Dial Nissan of Chicago, INFINITI of Chicago, Dial Chrysler Dodge Jeep Ram of Chicago, and Jeep of Chicago. Please share each store's Tekion dealer ID and location ID with AMQUR for the integration mapping.
>
> The authorization covers the scopes listed in AMQUR's request: CRM leads and activities, messaging through Tekion, tasks and notes, and appointments. Each scope is enabled per store only after we confirm it in writing. We can revoke this authorization at any time.
>
> [Name, title, Dial Auto Group] [Date]

## Track 1 — technical request from AMQUR to Tekion

Subject: **APC integration — dealer-authorized scope and sandbox request (AMQUR for Dial Auto Group, 5 rooftops)**

> AMQUR is building a dealer-authorized CRM follow-up integration for the five Dial Auto Group stores named in the attached authorization letter. Please tell us the supported APC enrollment path, and send API documentation and sandbox credentials through your approved secret channel.
>
> **Scopes requested.** We start read-only and enable each write scope per store, only after written approval.
>
> | # | Capability | Why | Side effect |
> |---|---|---|---|
> | 1 | Leads: list new/updated since a cursor; read one lead with owner, status, source, vehicle of interest | Prioritize follow-up | Read |
> | 2 | Conversation history (SMS, email, chat) per lead, with message ids and timestamps | Context; detect customer replies | Read |
> | 3 | **Webhook or event feed for inbound customer messages and lead changes**, signed | Stop automation the moment a customer replies; honor opt-outs instantly | Read |
> | 4 | Contact preferences and do-not-contact / opt-out state per channel | Never contact a customer who opted out | Read |
> | 5 | Follow-up tasks and appointment status for a lead | Avoid duplicate work | Read |
> | 6 | Send SMS / email **through Tekion** as the store, with a message id we can read back | Messages stay in the store's own record and number | Write |
> | 7 | Create follow-up task; add note to lead | Hand-offs to staff | Write |
> | 8 | Appointment availability (sales, service), and create / reschedule / cancel with a reference we can read back | Booking without double-booking | Write |
>
> **Please also provide:**
> - OAuth / credential model, and the scopes per item above;
> - rate limits;
> - idempotency keys for writes;
> - webhook signature verification;
> - sandbox sample data;
> - data-retention and AI-use policies;
> - certification steps for production;
> - any per-store fees.
>
> **Our commitments:**
> - We use documented APIs only, with no private endpoints and no screen scraping on this track.
> - Credentials are held in a secrets vault.
> - Every write is verified by a separate read before it is reported as done.
> - Kill switches exist per store and per department.
> - We start with one store, Dial Nissan of Chicago, in sandbox.
>
> **Reply requested:** program contact, the scope and dealer mapping worksheet, documentation access and sandbox onboarding steps.

### Where each scope lands in AMQUR

The adapters are already written to these contracts, so each scope is a connector to build, not a redesign.

| Scope | AMQUR contract | Status today |
|---|---|---|
| 1, 4, 5 | `CrmAdapter.listLeads` (`adapters/crm-adapter.ts`) | BLOCKED; fed by employees and exports |
| 2, 3 | `ReplySource` (`adapters/reply-detection.contract.ts`) | BLOCKED (`UnavailableReplySource`); employees record replies by hand |
| 6, 7 | `CrmAdapter.executeWrite` + `verifyWrite` | BLOCKED; employees send and confirm |
| 8 | `SlotSource` (`adapters/appointment-availability.contract.ts`) | BLOCKED (`UnavailableSlotSource`); staff book and enter the Tekion reference |

## Track 2 — question for Dial Auto Group's counsel

> Does our Tekion subscription agreement (and any order form or acceptable-use terms) allow a vendor we authorize to operate a dedicated, least-privilege Tekion user through the normal web interface by automation, for our own dealerships' CRM follow-up? Are there restrictions on automated access, on vendors acting for us, or on exporting CRM data to a vendor? Please quote the clauses.

## Track 3 — permission request from Dial Auto Group to Tekion (only if track 1 is slow or declined)

> Dial Auto Group requests Tekion's written permission for our vendor AMQUR to operate one dedicated Tekion user per store through the standard Tekion web interface. The purpose is CRM follow-up: reading leads and conversations, and, only where we later approve, sending messages, adding notes and tasks, and booking appointments.
>
> The worker would run under these conditions:
> - no private endpoints;
> - no bypassing of MFA, CAPTCHA or rate limits;
> - no disguising automation;
> - a dedicated least-privilege user per store, created by our administrator;
> - every action logged and attributable;
> - a kill switch per store.
>
> Please confirm whether this is permitted, and under what conditions.

The browser contract (`adapters/browser-connector.contract.ts`) already fixes these rules. No browser code will be written until this permission exists in writing.

## Per-store information we will need, whichever track wins

| Store | Tekion dealer ID | Location ID | Dedicated user (track 3) | Store approver |
|---|---|---|---|---|
| Dial Chevy of Chicago | | | | |
| Dial Nissan of Chicago (pilot) | | | | |
| INFINITI of Chicago | | | | |
| Dial CDJR of Chicago (South) | | | | |
| Jeep of Chicago (North) | | | | |

North and South CDJR are separate stores with separate IDs. Never reuse one store's approval for another.

## From access to autonomy, in order

1. Sandbox read (scopes 1–5) at Nissan. Run contract tests against the sandbox; the status becomes SANDBOX VERIFIED.
2. Production read at Nissan. Replies are detected automatically, and opt-outs from Tekion flow into suppression. Still Assist mode.
3. Counsel-approved communication policy (R7), consent basis (R11) and identities (R13).
4. Send through Tekion at Nissan in **Supervised** mode: a manager approves each message, and the message id is read back.
5. Booking through `SlotSource`, verified by read-back.
6. Per-workflow autonomy permits (R12), for routine workflows only.
7. Repeat steps 1–6 at the other four stores, each with its own approvals.
