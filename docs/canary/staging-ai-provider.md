# Staging AI provider configuration (no secret values)

Live LLM on staging is **optional** for internal canary. Without a key, the API must remain up and use deterministic / non-LLM paths — never invent dealership facts.

## Railway → project `dial-us-now-platform` → environment `staging` → service `api`

Set (or confirm) these **variable names** only via the Railway Variables UI or `railway variables set` (do not paste secrets into chat, git, or docs):

| Variable | Required for live LLM? | Notes |
|----------|------------------------|-------|
| `ANTHROPIC_API_KEY` | Yes (if using Anthropic) | Owner-supplied; never commit |
| `AI_PROVIDER` | Recommended | e.g. `anthropic` when key is set |
| `AI_MODEL` | Recommended | Approved staging model id only |
| `AI_PROVIDER_API_KEY` | Alternate | Use only if app validation expects this name instead of `ANTHROPIC_API_KEY` |

Worker service does **not** need the AI key unless a worker path calls the LLM (current outbox worker does not).

## After the key is set

1. Redeploy **api** (Railway will restart with new env).
2. Confirm `/api/health` still ready.
3. Run truthfulness suite locally/CI:

```bash
cd backend
npm test -- --testPathPattern='truthfulness|canary-gate'
```

4. Re-run employee canary prompts that exercise generative answers.
5. Confirm prompt-injection attempts still refuse fabricated deals/rebates.

## Explicitly do not set for canary

- Production Anthropic keys in staging (use a staging-scoped key)
- Vendor Tekion/vAuto credentials
- Production CRM webhook unless a **staging** sink is authorized

## Verification without printing secrets

```bash
railway variables --service api --json | python3 -c "import json,sys;d=json.load(sys.stdin);print('ANTHROPIC_API_KEY','SET' if d.get('ANTHROPIC_API_KEY') else 'MISSING')"
```
