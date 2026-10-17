# Architecture

AMQUR is a multi-tenant automotive concierge: **verified actions, not plausible answers**. The LLM shapes language; dealership facts come only from tools and providers; external actions become facts only after the provider confirms.

```
Dealer website ──(one script, Shadow DOM)──► Widget (Concierge Canvas)
                                               │  widget JWT (origin-bound) + signed conversation id
                                               ▼
                          NestJS API ── /api/chat ──► ChatOrchestrator
                               │                         │ understandTurn (multi-intent, deterministic)
                               │                         │ tools: inventory, payment(policy), appointments,
                               │                         │        parts, finance/credit, trade, hours, knowledge,
                               │                         │        handoff, consent
                               │                         │ ClaimEvidence (TruthResolver, freshness)
                               │                         │ DialogueStyle → LLM polish (router) → grounding guard
                               │                         ▼
                               │                  JourneyStore (Postgres, optimistic concurrency)
                               │
                               ├── /ops, /knowledge, /appointments, /campaigns, /privacy  ◄── Command Center (/cc)
                               ├── /webhooks/twilio/*  (official signature validation)
                               └── Outbox (Postgres, SKIP LOCKED leases) ──► Worker
                                         topics: crm.webhook, escalation.notify, appointment.requested,
                                                 crm.tekion.lead-sync (gated), messaging.send, campaign.step
```

## Processes

| Process | Entry | Role |
|---|---|---|
| API | `dist/main.js` | HTTP API, Command Center static assets at `/cc`, outbox tick (optional) |
| Worker | `dist/worker.js` | Outbox processing, retention job; liveness on `/api/health/live` |

Both are safe to scale horizontally: conversation state is loaded per turn from Postgres and saved with a `stateVersion` compare-and-set; outbox rows are claimed with `FOR UPDATE SKIP LOCKED` and DB-clock leases; the LLM circuit breaker is shared through Redis when available (in-process fallback). Redis loss degrades caching/breaker sharing only — business state is in Postgres.

## Key modules

| Module | Responsibility |
|---|---|
| `chat/understanding` | Multi-intent NLU with evidence/confidence; adversarial-word safeguards; pending-question context |
| `chat/chat.orchestrator.ts` | Turn pipeline, capability gating, tool execution, critical writes, response composition |
| `chat/dialogue` | Acknowledgement rules, one-question discipline, natural splitting, delivery hints |
| `appointments` | Lifecycle + provider-neutral scheduling registry |
| `locations/store-hours.service.ts` | Hours truth (tz, DST, holidays, departments; verified only) |
| `finance` | Financial assumption policy, finance requests, credit-application handoff |
| `source-authority` | TruthResolver, ClaimEvidence, grounding guard |
| `integrations` | Outbox, vault, Tekion (fail-closed), CRM sync gate, inventory feeds |
| `messaging` | Consent ledger, Twilio provider, webhooks, campaign engine |
| `operations` | Command Center APIs |
| `knowledge` | Lifecycle, SSRF-safe ingestion, hybrid retrieval |
| `privacy`, `observability/retention` | Data subject requests, retention |

## Data model highlights

`Conversation(state, stateVersion, aiPaused, handoffState)`, `Message`, `Lead(score, scoreReasons, scoreVersion, nextBestAction)`, `Appointment(provider, externalProviderId, requestedAt, timezone, provenance, idempotencyKey)`, `PartsInquiry`, `FinanceRequest(creditLinkState, aprSource)`, `TradeRequest`, `ConsentRecord`, `OutboundMessage`, `FollowUpCampaign(version)`, `OutboxEvent(claimedBy, leaseExpiresAt)`, `KnowledgeDocument(status, visibility, effective/expiry)`.

## Graceful degradation

| Dependency down | Behavior |
|---|---|
| LLM (all providers) | Deterministic drafts sent as-is; every tool flow still works (the e2e suites run this way) |
| Inventory stale/absent | Freshness disclosure or capability block; no availability claims |
| Tekion | No confirmation claims; requests persist; writeback gated |
| CRM webhook | Outbox retries → DLQ visible in Command Center; assistant never claims notification |
| Messaging | Messages suppressed/queued; never described as sent |
| Redis | Cache + breaker sharing degrade to in-process |
| API replica crash | Next request on any replica reloads state from Postgres |
| Worker crash | Lease expiry lets another worker resume |
