# Reliability

- OutboxEvent for async side-effects
- WebhookInbox with replay protection
- CircuitBreakerService (in-process; Redis recommended for multi-instance)
- Inventory anomaly rejection preserves LKG
- LLM failures degrade polish only — inventory/leads/handoff still work
