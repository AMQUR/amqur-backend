# Data processing

| Data | Where | Purpose | Retention |
|---|---|---|---|
| Chat messages | `Message` (redacted of SSN/card/bank data before storage) | Conversation continuity, staff handoff | Hard-deleted with conversation after `Tenant.dataRetentionDays` (default 365) of inactivity |
| Contact details | `Lead`, request records | Follow-up | Until privacy deletion request (pseudonymized) |
| Consent records | `ConsentRecord` | Proof of opt-in/out | Retained; endpoints pseudonymized on deletion requests |
| Analytics | `AnalyticsEvent` (PII keys stripped) | Funnel metrics | `analyticsRetentionDays` (default 400) |
| Audit logs | `AuditLog` | Security evidence | Not deleted by retention |
| Uploads | `FileObject` + storage | Trade/service photos, documents | Marked deleted with conversation; storage lifecycle purges |
| LLM egress | Model provider | Rephrasing drafts | Contact PII, credentials, tokens redacted before send |

Never collected in chat: SSN, full bank accounts, card numbers, passwords. Pasted values are redacted, not echoed, and the customer is redirected to the dealership's secure credit application.

Legal hold: `Tenant.legalHold = true` stops all deletion for that tenant.
Data subject requests: `POST /api/privacy/export`, `POST /api/privacy/delete` (admin, exact email/phone match, audited).
These controls support, but do not by themselves constitute, compliance certification.
