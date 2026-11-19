# Reliability

- OutboxEvent for async side-effects
- WebhookInbox with replay protection
- CircuitBreakerService (in-process; Redis recommended for multi-instance)
- Inventory anomaly rejection preserves LKG
- LLM failures degrade polish only — inventory/leads/handoff still work

## Outbox leases and attempts

- A worker claims a batch under one lease (`OUTBOX_LEASE_MS`, 120 s) and handles rows serially.
- Immediately before each handler `OutboxService.beginHandling` re-checks, on the database clock,
  that this worker still holds an unexpired lease, stamps `handlerStartedAt` and renews the lease
  for that row. A row that is no longer owned is skipped (metric `outbox.lease_lost`) — the
  worker's in-memory copy is stale and another replica has it.
- A lapsed lease counts as an attempt only when the handler had actually started
  (`handlerStartedAt IS NOT NULL`). A row that merely waited in a slow batch is not charged.
- An event abandoned `OUTBOX_MAX_ATTEMPTS` times is dead-lettered without running its handler;
  the topic's abandon hook (`registerAbandonHandler`) then settles the domain row. A handler that
  runs longer than one lease can still be reclaimed and run twice: handlers must stay idempotent.
