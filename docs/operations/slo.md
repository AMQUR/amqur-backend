# SLO / error budgets

**Never claim 100% availability.**

| SLO | Target | Window |
|-----|--------|--------|
| API availability (readiness success) | 99.9% | monthly |
| Chat success (non-5xx) | 99.5% | monthly |
| Inventory freshness (FRESH|DEGRADED share of sellable) | ≥ 95% when inventory enabled | weekly |

## Error budget (99.9% monthly)

~43 minutes downtime / month. Burn alerts at 25% / 50% / 100% of budget.

When budget exhausted: freeze risky deploys; prioritize reliability.
