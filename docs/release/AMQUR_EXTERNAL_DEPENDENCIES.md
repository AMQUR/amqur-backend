# AMQUR — external dependencies (honest blockers)

**As of:** 2026-11-20  
Only dependencies that cannot be completed by engineering alone.

| Dependency | Responsible party | Missing input | Affected capability | Engineering completed | Evidence now | Safe disabled behavior | Required external action | Verification after |
|---|---|---|---|---|---|---|---|---|
| vAuto export delivery into ten SFTP folders | vAuto / Dial Difference feed ops | Actual New/Used files in `/chevy|nissan|infiniti|cdjr_south|jeep_north/{new,used}/` | Live inventory truth | SFTP client, pin, map, lifecycle, diagnostic | `AMQUR_VAUTO_TEN_FEED_VERIFICATION.md` — CONNECTED, 10× EMPTY | Sync/publish flags false; no fabricated stock | Deliver exports; owner confirms | Re-run worker diagnostic → expect `REAL_FEED_VERIFIED` |
| Price + photo publication rights | Dealership / counsel | Written approval per rooftop | Customer-visible price/photos | Publish flags + provenance fields | Flags `false` on worker | Prices/photos suppressed | Approve fields/rights | Enable `AMQUR_VAUTO_PUBLISH_*` on staging only first |
| Verified ADF recipient per rooftop | Each store CRM admin | Confirmed inbound address + parser expectations | Live lead delivery | ADF serializer, outbox ladder, sandbox sinks | Sandbox DEMO only | Production refuses unverified destinations | Confirm addresses + allow one synthetic test | Synthetic lead → ACCEPTED/MATCHED |
| Mail relay + SPF/DKIM/DMARC | Owner (DNS) + relay vendor | Sending domain + credentials | Real ADF email | Outbox + encrypted recipient config | Not production-verified | Queued/BLOCKED without live send | Provision relay + DNS | Staging synthetic send receipt |
| Tekion APC scopes + credentials | Tekion account team | Official schemas, sandbox, dealer IDs | CRM/DMS/scheduler APIs | Fail-closed adapters, mocks, request packet | BLOCKED | Adapter returns BLOCKED; scheduler-link handoff | Complete APC enrolment | Contract tests + sandbox receipt |
| Staging model API key | Owner | Scoped key + budget | Live-model eval | Eval harness + fixtures | LLM health `missing` on staging | Honest unavailable; fixture eval only | Provision key in staging vault | `eval:live-model` / health llm up |
| DealerOn / Apollo install permission | CMS vendors + owner | Install approval on rooftop sites | Customer-facing widget | Embed switch gated off; install docs | Group concierge retained | Feature flags off; no production CMS edits | Approve install per site | Origin allowlist + single launcher QA |
| Consent wording EN/ES | Counsel | Approved copy | Real customer leads/messages | Consent checkboxes + versioning | Not counsel-approved | Forms use draft; no outbound automation | Approve wording | Legal sign-off recorded |
| Human screen-reader pass | Human tester | VoiceOver/TalkBack/NVDA run | A11y release gate | Automated axe + keyboard tests in CI | Manual pass pending | Do not claim full a11y complete | Execute `ACCESSIBILITY_MANUAL_TEST.md` | Signed checklist |
| PR undraft / merge authorization | Owner / reviewers | Explicit merge approval | Staging→main promotion | Draft PRs #55/#29/#13 CI green | Drafts open | No merge of customer activation | Review + undraft when gates allow | Post-merge staging smoke |
| Customer-facing production activation | Owner | Capability-specific release gates | Live inventory, CRM, booking, site install | Fail-closed flags | Staging only | All sensitive flags false | Written go-live per capability | Canary + monitoring |

## Cleared this session (no longer blocking connection)

| Item | Status |
|---|---|
| `AMQUR_VAUTO_SFTP_PASSWORD` on worker-staging | SET — live auth succeeded |
| Host fingerprint independent verify | MATCH `SHA256:RB74t0jOln5yBXsa35xeTZgIfpynQSiTKnn0xzHK11Y` |
