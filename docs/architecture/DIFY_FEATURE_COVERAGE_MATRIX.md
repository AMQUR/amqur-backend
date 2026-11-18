# Dify Feature Coverage Matrix (AMQUR decisions)

Derived from the brief's feature list (Dify archive not available in workspace; no Dify code was read or copied).
Dify's modified Apache-2.0 licence restricts multi-tenant operation: **functional reference only, original code**.

| Capability | Decision | AMQUR source of truth | Phase |
|---|---|---|---|
| Hybrid RAG (vector+keyword, rerank) | Enhance existing | `KnowledgeModule`, `KnowledgeRetrievalService`, `EmbeddingProvider` (disabled) | 1 |
| Document ingestion (PDF/DOCX/HTML/CSV) | Enhance existing | knowledge ingestion/chunking | 1 |
| Workflow DAG + branching | Adopt independently | `src/workflow-lab/*` | 2 |
| Loops / iteration | Defer (default acyclic) | — | later |
| Code / HTTP / shell nodes | Reject (public chat); sandbox only after security review | — | P3 |
| Tool registry | Adopt independently, policy-engine gated | `src/tool-registry` catalog + `ToolActionRequest` + existing `OutboxEvent`/`AuditLog`; mock providers only (Phase 4a) | 4 |
| Human-in-loop approval | Adopt independently | `ActionApproval`, outbox/inbox | 4 |
| Visual editor | Adopt independently (original UI) | `command-center/` | 3 |
| Prompt versions / A-B | Enhance existing | `LlmRouterService`, prompt versions, experiments | 5 |
| Evaluation / golden cases | Adopt independently | `test/evidence`, eval scripts | 5 |
| Agent personas | Enhance existing (policy profiles) | playbooks | 5 |
| Marketplace/plugins | Reject (curated recipes only) | — | — |
| Dify server/web/branding | License blocked | — | — |
| Observability traces | Enhance existing, PII-redacted | request-id interceptor | 2 |
| Multi-channel (voice/SMS) | Defer, feature-flagged | — | P2/P3 |
