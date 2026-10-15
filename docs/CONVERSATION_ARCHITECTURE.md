# Conversation architecture: model-led replies, deterministic business execution

Updated 2026-10-14.

## Turn flow

```
customer message
  │
  ├─ 1. rules: understandTurn()            fast, deterministic intents + entities
  │      (owner-tested phrasings, typos, slang, Spanish, short follow-ups)
  │
  ├─ 2. model understanding (Claude)        interpretTurn(): schema-validated JSON
  │      used on every substantive turn      {goal, intents[], entities{}}
  │      except the fast path (confident,    merged by mergeInterpretation():
  │      specific rule match)                 - only allowed intents (no cancel/safety)
  │                                            - confident model reading outranks a weak rule,
  │                                              never a confident one
  │                                            - entities fill gaps only; a ZIP/amount must
  │                                              literally appear in the customer's text
  │                                            - never turns identity/manager questions into
  │                                              a handoff
  │
  ├─ 3. authorized tools (deterministic)    inventory search/lookup, price, payment
  │      via the existing NestJS services   calculator, OTD estimator/quote request,
  │                                         credit destination, appointments (REQUEST
  │                                         only), service/parts requests, leads,
  │                                         escalations, hours, live info
  │      → tool facts + cards + server draft
  │
  ├─ 4. composition (Claude)                ConversationComposerService.compose():
  │      input: last 8 transcript turns,    the model writes the reply in its own words,
  │      structured memory, tool facts,     answers the question first, may add general
  │      card summaries, live data, the     knowledge and small talk
  │      server draft (safe default)
  │
  ├─ 5. grounding validator                 validateComposedReply(): every number from
  │      (one repair, else the draft)       draft/tools/customer/live data; no commitment
  │                                         words the draft didn't use; caveats kept
  │                                         ("estimate", "request", "preview",
  │                                         "in transit"); no live score without live
  │                                         data; complete sentences
  │
  └─ 6. persist + respond                   journey state, message, provenance, cards
```

Business actions (records, links, requests) happen only in step 3, through the same
authorized services as before. The model never writes data, never receives database or
network access, and its proposals are validated before any handler runs.

## Provenance on every reply (`provenance.*`)

| Field | Values |
|---|---|
| `languageModel` | `composed` (model reply passed validation), `repaired` (passed after one grounded retry), `answered` (model answered a knowledge question from verified data), `discarded` (model output rejected → server draft sent), `none` (no model used) |
| `modelInterpreted` | `true` when the model's understanding was merged into the turn |
| `fallbackReason` | validator/model reasons when the draft was sent instead |

## Memory

Structured journey state (Postgres, optimistic concurrency): selected vehicle (VIN, stock,
status), vehicles shown, search criteria, budget, payment method, last payment estimate, OTD
request + ZIP, appointment status, service vehicle/need, parts request, trade-in, credit-link
state, staff request, first name, the assistant's last question and what a "yes" means
(`lastOffer`, valid one turn), open questions, fallback count. The composer receives a compact
summary (no phone/email) plus the last 8 messages. Topic switches keep the sales vehicle; a
stale question cannot hijack a new topic.

## Live information

`LiveInfoService` (server-side only, fixed hosts, 4 s timeout, 10 min cache):

- Weather: US National Weather Service (`api.weather.gov`), public-domain, no key, commercial
  use permitted. Chicago-area places resolved from a built-in table (no geocoder vendor).
  Set `LIVE_INFO_USER_AGENT` to an identifying string with contact info (NWS requirement).
  `LIVE_WEATHER_PROVIDER=off` disables it.
- Sports: **not available** — no licensed sports-data provider is configured. Replies say so;
  the validator rejects score-like claims without live data. Adding a provider is an owner
  decision (contract/cost).

## Spend and abuse controls

Token budget, dollar caps (group + per tenant), concurrency shedding (existing). New: in
production with `REDIS_URL` set, an unreachable shared counter **fails closed**
(`spend_store_unavailable`) instead of counting per replica. Model calls per turn: 0 (no
model), 1–2 typically (understanding when needed + composition), at most 3 (one composition
repair).

## Evaluation

`test/eval/conversation-eval.e2e-spec.ts` — 101 turns / 11 journeys (main set) and a 27-turn
blind paraphrase set (`EVAL_SET=holdout`). In-process for CI; `EVAL_TARGET=http://localhost:3001`
for the keyed owner demo. Writes JSON + Markdown transcripts to `test/evidence/`. Rubric and
critical checks are documented at the top of `conversation-eval.dataset.ts`.
