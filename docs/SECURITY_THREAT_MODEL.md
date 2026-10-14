# Security threat model (2026-10)

| Threat | Defense (implemented) | Test |
|---|---|---|
| Cross-tenant data access | Tenant from JWT only; `resolveTenantId`; every query tenant-scoped; location scope for bound staff | `tenant-isolation`, `operations`, `data-governance` |
| Widget token abuse / origin spoofing | Exact-origin allowlist, fail-closed when empty, short TTL, separate secret option, canary strict origins | platform e2e |
| Conversation hijack | Server-issued HMAC tenant-bound conversation ids; forged ids get a new conversation | journeys, isolation |
| IDOR (saved vehicles, uploads, ops) | Signed ids, tenant-scoped lookups (404 not 403 leak) | isolation, data-governance |
| Credential theft / admin session theft | bcrypt, short access TTL, refresh rotation, logout-all, TOTP MFA w/ replay protection, typed tokens | auth specs, `auth-mfa` |
| Privilege escalation | RolesGuard, manager-only approvals, admin-only settings/privacy/MFA reset | operations e2e |
| SSRF | Feed/ingestion allowlists, private-range DNS check, manual redirects | feed-url spec |
| Prompt injection / tool injection / poisoned knowledge | Deterministic tool routing (LLM cannot call tools), knowledge as data + neutralization, publish workflow, grounding guard discards new claims | grounding specs, ai-eval red team |
| Malicious uploads | Magic-byte verification, extension from type, quotas, quarantine, attachment-only + sandbox CSP, signed short links | data-governance |
| Webhook forgery / replay | HMAC-SHA256 + timestamp + event id + rotation (AMQUR); Twilio official signature; verify-before-dedupe | security-primitives, messaging |
| Messaging abuse | Consent ledger, STOP honored immediately, frequency caps, quiet hours, provider opt-out codes | messaging |
| Open redirect / credit-link tampering | Destination from verified config at click time; https + allowlist; signed opaque token | journeys, security-primitives |
| Rate abuse | Global + per-route throttles (token 30/min, chat 40/min) | load profile |
| PII in logs / LLM egress | `redactForLog`, `redactForLlm`; credit-sensitive input redacted before storage | security-primitives, journeys |
| XSS (widget/Command Center) | React escaping, no `dangerouslySetInnerHTML`, Shadow DOM, strict CSP on `/cc` | Playwright |
| CSRF | Bearer tokens (no ambient cookies) for APIs; canary cookie scoped + signed | — |
| Supply chain | Lockfiles, `npm ci`, SBOM artifact, minimal new dependencies (none added to backend) | CI |
| Database restore risk | Additive migrations only; destructive-pattern CI scan; restore drill required (B-11) | CI |

Residual risks: DNS rebinding race between lookup and connect (mitigate with platform egress policy); refresh token in `sessionStorage` (mitigated by CSP); access tokens remain valid ≤15 min after logout-all.
