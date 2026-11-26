# Tekion capability map — CRM Workforce

**As of 2026-11-25.** Applies identically to all five rooftops today, because no rooftop has any system connection to Tekion: Dial Chevy of Chicago, Dial Nissan of Chicago, INFINITI of Chicago, Dial CDJR of Chicago (South), Jeep of Chicago (North). When a connection is authorized it is recorded per rooftop; one rooftop's permission never applies to another.

Nothing in this table was observed in Tekion. No Tekion screen, export or API was accessed while building this. "Implemented" means AMQUR code exists and is tested against synthetic data; it says nothing about Tekion.

## Integration methods

| Method | What it is | Status | What unblocks it |
|---|---|---|---|
| A. Employee-assisted | An employee reads Tekion, enters the minimum context here, sends the drafted reply from Tekion themselves, records the outcome | Implemented, tested on synthetic data. Not yet used by staff | Deploy + rooftop flag + staff accounts |
| B. Authorized export | A manager exports leads from Tekion as CSV and uploads the file | Implemented, tested on synthetic files. Never run on a real Tekion export, so column names are unconfirmed (mapping screen handles differences) | Recorded import authorization per rooftop; privacy sign-off; `crmWorkforceRealImports` |
| C. Authorized browser worker | Dedicated browser session acting through visible Tekion screens | Contract only (`browser-connector.contract.ts`). No driver, no selectors, no session code | Tekion agreement review + written Tekion permission + dealership authorization + dedicated CRM identity |
| D. Tekion APC API | Official partner API | BLOCKED. No spec, scopes, sandbox or credentials | Tekion APC enrolment and granted scopes |
| E. Existing lead delivery (ADF) | AMQUR → store lead mailbox, already built in the platform | Outbound to Tekion only; not sending in production (`ADF_SEND_ENABLED=false`). Not a way to read Tekion | Separate ADF release gate |
| F. Approved integration partner | A Tekion-approved third party | Not investigated: no partner is under contract | Owner decision |

## Operations

Read / Write columns say what AMQUR can do **today** through each method. "Staff" = an employee does it in Tekion; AMQUR records their statement.

| Operation | A. Employee-assisted | B. Export | C. Browser | D. API | Verification | On failure | Production-verified |
|---|---|---|---|---|---|---|---|
| Lead search | Staff looks up | — | Blocked | Blocked | n/a | n/a | No |
| Lead details | Staff enters minimum context | Read (file) | Blocked | Blocked | Export time shown as "data as of" | Row rejected with reason | No |
| New leads | Staff enters | Read (created date) | Blocked | Blocked | As above | As above | No |
| Lead status | Staff | Read | Blocked | Blocked | As above | Unknown status treated as open | No |
| Lead age | — | Read (derived) | Blocked | Blocked | Derived from created date | No date → no age cohort | No |
| Assigned salesperson | Staff enters | Read | Blocked | Blocked | As above | "unassigned" | No |
| Vehicle of interest | Staff enters | Read | Blocked | Blocked | As above | Omitted | No |
| Contact preferences | Staff | Read (do-not-contact column, if exported) | Blocked | Blocked | Missing column → "unknown", shown as a warning | Unknown ≠ permitted | No |
| SMS history | Staff pastes the customer's message | Last message only, if exported | Blocked | Blocked | Staff-entered text is marked as such | Never triggers an unapproved send | No |
| Email history | Staff pastes | Not in a standard export | Blocked | Blocked | As above | As above | No |
| Inbound replies | Staff pastes | Last-contact date only | Blocked | Blocked | As above | As above | No |
| Communication consent | Not read from Tekion | Not read from Tekion | Blocked | Blocked | AMQUR's own consent ledger only | No record → no system send; consent review queue | No |
| Follow-up tasks | Read: none. Write: staff creates in Tekion from a work item | Read (next follow-up date) | Blocked | Blocked | Staff statement | Item stays open | No |
| Appointment history | — | Read (status, date) | Blocked | Blocked | Export time | — | No |
| Appointment availability | **Not available by any method** | — | Blocked | Blocked | Verified store hours only (not slots) | Request refused outside verified hours | No |
| Appointment create / change | Write: staff books in Tekion, enters the Tekion reference | — | Blocked | Blocked | Staff statement + reference; never "confirmed" | Stays a request | No |
| Notes | Write: staff adds in Tekion from a work item | — | Blocked | Blocked | Staff statement | Item stays open | No |
| Duplicate leads | AMQUR-side only (same phone/email hash at one rooftop) | AMQUR-side | Blocked | Blocked | Deterministic | Duplicate gets no work of its own | No |
| Prospecting | — | Read (mining queues) | Blocked | Blocked | — | — | No |
| Visited unsold | Staff | Read (visit date) | Blocked | Blocked | Export time | — | No |
| Lost opportunities | — | Read (status) | Blocked | Blocked | — | Manager review queue only | No |
| Sold customers | — | Read (status) → recorded as "deal record", never a verified sale | Blocked | Blocked | — | — | No |
| Service inquiries / appointments | Staff enters; work item to advisor | Read if exported with a department column | Blocked | Blocked | Staff statement | — | No |
| Parts inquiries | Staff enters; work item to parts counter | Read if exported | Blocked | Blocked | Staff statement | — | No |
| Customer ownership | Read from entered / exported owner; **never changed** by AMQUR | Read | Blocked | Blocked | — | — | No |
| Send SMS / email | Staff sends from Tekion | — | Blocked | Blocked | Staff statement (`STAFF_CONFIRMED`) | Draft discarded | No |
| Reports | — | Any report exported as CSV with a lead id | Blocked | Blocked | — | — | No |

## What this means

- Employee-assisted (A) and export (B) are the only methods that can run before Tekion grants anything, and both keep an employee as the one acting in Tekion.
- No method available today can read Tekion conversations automatically, verify a send, or see appointment availability. Any claim of "sent" or "booked" is therefore an employee's statement.
- Tekion-native SMS/email (the preferred channel) is reachable only through C or D. No separate SMS or email provider has been purchased or proposed.
