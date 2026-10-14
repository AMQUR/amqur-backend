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
});
