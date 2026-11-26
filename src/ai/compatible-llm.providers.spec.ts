import { CompatibleLlmProviders } from './compatible-llm.providers';
import { LlmRouterService } from './llm-router.service';

const cfg = (env: Record<string, string>) => ({ get: (k: string) => env[k] });

describe('OpenAI-compatible fallback providers', () => {
  it('exist only when both key and model are configured', () => {
    expect(new CompatibleLlmProviders(cfg({}) as never).list()).toEqual([]);
    expect(
      new CompatibleLlmProviders(cfg({ XAI_API_KEY: 'k' }) as never).list(),
    ).toEqual([]);
    const two = new CompatibleLlmProviders(
      cfg({
        XAI_API_KEY: 'k',
        XAI_MODEL: 'm1',
        OPENROUTER_API_KEY: 'k2',
        OPENROUTER_MODEL: 'vendor/m2',
        GEMINI_MODEL: 'm3',
      }) as never,
    ).list();
    expect(two.map((p) => p.providerId)).toEqual(['xai', 'openrouter']);
  });

  it('sends the configured model and bearer key, and never logs a body', async () => {
    const [p] = new CompatibleLlmProviders(
      cfg({
        DEEPSEEK_API_KEY: 'secret-key',
        DEEPSEEK_MODEL: 'the-model',
        DEEPSEEK_BASE_URL: 'https://example.test/v1/',
      }) as never,
    ).list();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const prev = global.fetch;
    global.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: ' hello ' } }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        }),
      };
    }) as never;
    try {
      const out = await p.generate({
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        model: 'claude-opus-5-5',
      });
      expect(out).toMatchObject({
        text: 'hello',
        provider: 'deepseek',
        model: 'the-model',
        inputTokens: 3,
        outputTokens: 2,
      });
      expect(calls[0].url).toBe('https://example.test/v1/chat/completions');
      const body = JSON.parse(String(calls[0].init.body));
      expect(body.model).toBe('the-model');
      expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' });
      expect(
        (calls[0].init.headers as Record<string, string>).Authorization,
      ).toBe('Bearer secret-key');
    } finally {
      global.fetch = prev;
    }
  });

  it('router orders primary, then LLM_FALLBACK_ORDER, and skips unconfigured providers', async () => {
    const mk = (id: string, ok: boolean, available = true) => ({
      modelId: () => 'm',
      providerId: id,
      isAvailable: () => available,
      generate: jest.fn(async () => {
        if (!ok) throw new Error('down');
        return { text: id, provider: id, model: 'm', latencyMs: 1 };
      }),
    });
    const anthropic = mk('anthropic', false);
    const openai = mk('openai', true, false);
    const xai = mk('xai', true);
    const gemini = mk('gemini', true);
    const cache = {
      getJson: async () => null,
      setJson: async () => undefined,
      getCounter: async () => 0,
      incrBy: async () => 0,
    };
    const r = new LlmRouterService(
      anthropic as never,
      openai as never,
      { increment: () => undefined } as never,
      cache as never,
      cfg({ LLM_FALLBACK_ORDER: 'gemini,xai' }) as never,
      { list: () => [xai, gemini] } as never,
    );
    const res = await r.route({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res).toMatchObject({ ok: true, attempts: 2 });
    expect(res.ok && res.result.provider).toBe('gemini');
    expect(xai.generate).not.toHaveBeenCalled();
    expect((await r.status()).order).toEqual(['anthropic', 'gemini', 'xai']);
  });
});
