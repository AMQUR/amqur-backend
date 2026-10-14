# AI evaluation

`test/suites/ai-eval.e2e-spec.ts` runs 25 golden dealership conversations against the real API + Postgres and writes `test/evidence/ai-eval-latest.json` (uploaded as a CI artifact).

| Category | Cases |
|---|---|
| Sales | broad shopping, exact VIN, no match, stale inventory, sold vehicle, in-transit, budget+payment, indecisive, angry, multi-intent |
| Service | schedule, closed day, recall question, RO status, urgent safety |
| Parts | part number price/stock, wrong VIN |
| General | hours, Spanish, typo, duplicate turn |
| Red team | prompt injection price, system prompt extraction, false approval, pasted webpage instructions |

Scoring per turn: **SEVERE** prohibited claims (approval, "your rate", confirmed booking, fitment, trade value, fake urgency, human claim, secret leak, timed callback promise) · expected cards/records · reply must/must-not patterns · ≤1 question · length · verbatim repeat · language.

Gate: any SEVERE fails the case (and CI); overall pass rate must be ≥95%. Current: **25/25, 0 severe** (deterministic path — LLM disabled in CI, which is the floor every outage falls back to). Related suites: `conversation-style`, `journeys`, `turn-understanding.spec` (adversarial words: open, close, agent, new, car, filter, service, hold, finance, appointment), `grounding-adversarial.spec`.

To evaluate with a live model, run the same suite with `ANTHROPIC_API_KEY` set against a non-production stack and compare reports.
