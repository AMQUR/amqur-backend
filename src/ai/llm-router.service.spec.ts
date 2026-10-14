import { LlmRouterService } from './llm-router.service';

function provider(
  id: string,
  impl: () => Promise<{ text: string }>,
  available = true,
) {
  return {
    providerId: id,
    isAvailable: () => available,
    generate: jest.fn(async () => ({
      ...(await impl()),
      provider: id,
      model: 'm',
      latencyMs: 1,
    })),
  };
}
const metrics = { increment: jest.fn() };
const memCache = () => {
  const m = new Map<string, unknown>();
  return {
    getJson: async (k: string) => (m.get(k) as never) ?? null,
    setJson: async (k: string, v: unknown) => void m.set(k, v),
  };
};
const cfg = (primary = 'anthropic') => ({
  get: (k: string) => (k === 'LLM_PRIMARY_PROVIDER' ? primary : undefined),
});

describe('LlmRouterService', () => {
  it('falls back to the healthy provider and redacts PII before egress', async () => {
    const a = provider('anthropic', async () => {
      throw new Error('500');
    });
    const o = provider('openai', async () => ({ text: 'ok' }));
    const r = new LlmRouterService(
      a as never,
      o as never,
      metrics as never,
      memCache() as never,
      cfg() as never,
    );
    const res = await r.route({
      messages: [{ role: 'user', content: 'email me at sam@example.com' }],
    });
    expect(res.ok && res.result.provider).toBe('openai');
    const sent = (
      o.generate.mock.calls[0] as unknown as [
        { messages: Array<{ content: string }> },
      ]
    )[0].messages[0].content;
    expect(sent).not.toContain('sam@example.com');
  });

  it('opens the circuit after repeated failures and skips the provider (shared state)', async () => {
    const cache = memCache();
    const a = provider('anthropic', async () => {
      throw new Error('down');
    });
    const o = provider('openai', async () => ({ text: 'ok' }), false);
    const r1 = new LlmRouterService(
      a as never,
      o as never,
      metrics as never,
      cache as never,
      cfg() as never,
    );
    for (let i = 0; i < 4; i += 1)
      await r1.route({ messages: [{ role: 'user', content: 'x' }] });
    // a second replica sharing the cache sees the open circuit and does not call the provider
    const r2 = new LlmRouterService(
      a as never,
      o as never,
      metrics as never,
      cache as never,
      cfg() as never,
    );
    const calls = a.generate.mock.calls.length;
    const res = await r2.route({ messages: [{ role: 'user', content: 'x' }] });
    expect(res).toEqual({
      ok: false,
      reason: 'all_circuits_open',
      attempts: 0,
    });
    expect(a.generate.mock.calls.length).toBe(calls);
    expect((await r2.health())[0]).toMatchObject({
      provider: 'anthropic',
      circuitOpen: true,
    });
  });

  it('times out slow providers', async () => {
    const a = provider(
      'anthropic',
      () => new Promise((res) => setTimeout(() => res({ text: 'late' }), 200)),
    );
    const o = provider('openai', async () => ({ text: '' }), false);
    const r = new LlmRouterService(
      a as never,
      o as never,
      metrics as never,
      memCache() as never,
      cfg() as never,
    );
    const res = await r.route({
      messages: [{ role: 'user', content: 'x' }],
      timeoutMs: 20,
    });
    expect(res).toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('reports no provider when none configured (deterministic flows take over)', async () => {
    const a = provider('anthropic', async () => ({ text: 'x' }), false);
    const o = provider('openai', async () => ({ text: 'x' }), false);
    const r = new LlmRouterService(
      a as never,
      o as never,
      metrics as never,
      memCache() as never,
      cfg() as never,
    );
    expect(await r.route({ messages: [] })).toEqual({
      ok: false,
      reason: 'no_provider_configured',
      attempts: 0,
    });
  });

  const withUsage = (
    id: string,
    tokensIn: number,
    tokensOut: number,
    delayMs = 0,
  ) => ({
    providerId: id,
    isAvailable: () => true,
    generate: jest.fn(async () => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return {
        text: 'ok',
        provider: id,
        model: 'm',
        latencyMs: 1,
        inputTokens: tokensIn,
        outputTokens: tokensOut,
      };
    }),
  });
  const cfgWith = (env: Record<string, string>) => ({
    get: (k: string) => env[k],
  });
  const call = (r: LlmRouterService) =>
    r.route({ messages: [{ role: 'user', content: 'hi' }], timeoutMs: 1000 });

  it('enforces the daily token budget across calls and falls back to deterministic', async () => {
    const a = withUsage('anthropic', 600, 500);
    const off = provider('openai', async () => ({ text: 'x' }), false);
    const r = new LlmRouterService(
      a as never,
      off as never,
      metrics as never,
      memCache() as never,
      cfgWith({ LLM_DAILY_TOKEN_BUDGET: '1000' }) as never,
    );
    expect((await call(r)).ok).toBe(true); // 1,100 tokens used — over the cap now
    const second = await call(r);
    expect(second).toMatchObject({ ok: false, reason: 'budget_exhausted' });
    expect(a.generate).toHaveBeenCalledTimes(1);
    expect((await r.status()).budgetExhausted).toBe(true);
  });

  it('defaults to a finite budget when unset (spend is never unbounded)', async () => {
    const off = provider('openai', async () => ({ text: 'x' }), false);
    const r = new LlmRouterService(
      withUsage('anthropic', 1, 1) as never,
      off as never,
      metrics as never,
      memCache() as never,
      cfgWith({}) as never,
    );
    expect((await r.status()).dailyTokenBudget).toBe(2_000_000);
  });

  it('sheds load above the concurrency limit instead of queueing', async () => {
    const a = withUsage('anthropic', 1, 1, 50);
    const off = provider('openai', async () => ({ text: 'x' }), false);
    const r = new LlmRouterService(
      a as never,
      off as never,
      metrics as never,
      memCache() as never,
      cfgWith({ LLM_MAX_CONCURRENCY: '2' }) as never,
    );
    const res = await Promise.all([call(r), call(r), call(r)]);
    expect(res.filter((x) => x.ok)).toHaveLength(2);
    expect(res.find((x) => !x.ok)).toMatchObject({ reason: 'rate_limited' });
  });

  it('meters cost only from owner-configured prices, in micro-USD', async () => {
    const off = provider('openai', async () => ({ text: 'x' }), false);
    const r = new LlmRouterService(
      withUsage('anthropic', 1000, 200) as never,
      off as never,
      metrics as never,
      memCache() as never,
      cfgWith({
        LLM_COST_INPUT_PER_MTOK: '3',
        LLM_COST_OUTPUT_PER_MTOK: '15',
      }) as never,
    );
    const out = await call(r);
    expect(out.ok && out.result.costMicroUsd).toBe(1000 * 3 + 200 * 15);
    const r2 = new LlmRouterService(
      withUsage('anthropic', 1000, 200) as never,
      off as never,
      metrics as never,
      memCache() as never,
      cfgWith({}) as never,
    );
    const out2 = await call(r2);
    expect(out2.ok && out2.result.costMicroUsd).toBeUndefined();
  });
});
