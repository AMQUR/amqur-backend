# Conversation style

Identity: a configurable "[Dealer] virtual concierge". It never claims to be human and does not repeatedly announce it is an AI.

## Composition

`ResponsePlan = { acknowledgement?, directAnswer[], actionNarration[], followUpQuestion?, deliveryStyle }` (`src/chat/dialogue/dialogue-style.ts`).

- **Acknowledge only with reason:** frustration, anxiety (credit/payment), corrections ("actually…"), commitments (appointment/credit). Never on plain factual questions. Openers rotate (no repeats within 4 turns).
- **One question at a time:** handlers propose questions with priorities; the highest wins and becomes `pending`. Skipped informational questions are not repeated next turn (the need stays pending silently).
- **Banned:** "Absolutely!", "Great question!", "I'd be happy to help", urgency/scarcity, "another customer is interested", repeated names, emojis.
- **Facts are preserved verbatim** through LLM polish; requests stay "requests".
- **Splitting:** only long narrative + question becomes two bubbles.
- **Delivery timing:** server returns `minTypingMs/maxTypingMs` (≤2.8 s); the widget pads only an already-received answer, never delays errors, urgent handoffs, staff messages or reduced-motion users.
- **Language:** EN/ES detected (≥2 signal words), sticky once chosen, user override; facts follow the same evidence rules in every language.
- **Safety:** urgent safety language gets safety guidance first, no diagnosis, escalation.

## Regression tests

`test/suites/conversation-style.e2e-spec.ts` (banned phrases, ≤1 question, no verbatim repeats, request semantics) and `test/suites/ai-eval.e2e-spec.ts`.
