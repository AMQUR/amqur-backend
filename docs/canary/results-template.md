# Internal canary results template

**Window start (UTC):**  
**Window end (UTC):**  
**Facilitator:**  
**Build / deploy notes:**  
**API evidence URL:** https://staging-api.dialusnow.com/api/health  
**Widget evidence URL:** https://staging-widget.dialusnow.com/assistant-widget.iife.js  

## Environment

| Item | Value |
|------|-------|
| Backend PR | #22 @ SHA ________ |
| Widget PR | #13 @ SHA ________ |
| AI provider enabled? | yes / no |
| CRM webhook configured? | yes / no |
| Monitoring DSN configured? | yes / no |
| Origins allowlisted | list: ________ |

## Per-tenant results

| Tenant | Widget load | Truthful unavailable | Handoff honest | Isolation OK | Notes |
|--------|-------------|----------------------|----------------|--------------|-------|
| jeep-of-chicago | ☐ | ☐ | ☐ | ☐ | |
| dial-nissan-of-chicago | ☐ | ☐ | ☐ | ☐ | |
| dial-chevy-of-chicago | ☐ | ☐ | ☐ | ☐ | |
| infiniti-of-chicago | ☐ | ☐ | ☐ | ☐ | |
| dial-cdjr-of-chicago | ☐ | ☐ | ☐ | ☐ | |

## Cross-cutting

| Check | Pass/Fail | Evidence |
|-------|-----------|----------|
| Chromium | | |
| Firefox | | |
| WebKit | | |
| Mobile | | |
| Staging load EXPECTED_PILOT | | |
| No secrets in IIFE | | |
| No 5xx spike during canary | | |
| Redis degraded handling | | |

## Defects

| ID | Severity | Tenant | Summary | Status |
|----|----------|--------|---------|--------|
| | | | | |

## Facilitator recommendation

- ☐ Continue internal canary  
- ☐ Pause canary  
- ☐ Ready to consider limited pilot (origins + store approval required)  

**Signature / date:**
