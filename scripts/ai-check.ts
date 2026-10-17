/**
 * Live AI provider probe — ONE short request per configured provider, through the same
 * router the API uses (timeouts, budget, redaction). Prints configured/missing, model,
 * latency and token counts. Never prints keys.
 *
 *   ANTHROPIC_API_KEY=... npm run ai:check        (set the key in your shell, never in a file)
 */
import { AnthropicLlmProvider } from '../src/ai/anthropic-llm.provider';
import { OpenAiLlmProvider } from '../src/ai/openai-llm.provider';
import { LlmRouterService } from '../src/ai/llm-router.service';

async function main() {
  const config = { get: (k: string) => process.env[k] };
  const metrics = { increment: () => undefined };
  const mem = new Map<string, unknown>();
  const cache = {
    getJson: async (k: string) => (mem.get(k) as never) ?? null,
    setJson: async (k: string, v: unknown) => void mem.set(k, v),
    getCounter: async (k: string): Promise<number> => Number(mem.get(k) ?? 0),
    incrBy: async (k: string, by: number): Promise<number> => {
      const total = Number(mem.get(k) ?? 0) + by;
      mem.set(k, total);
      return total;
    },
  };
  const providers = {
    anthropic: new AnthropicLlmProvider(config as never),
    openai: new OpenAiLlmProvider(config as never),
  };
  for (const [name, p] of Object.entries(providers)) {
    if (!p.isAvailable()) {
      console.log(`${name}: missing (no key in this shell)`);
      continue;
    }
    const other = {
      providerId: 'none',
      isAvailable: () => false,
      generate: async () => {
        throw new Error('x');
      },
    };
    const router = new LlmRouterService(
      (name === 'anthropic' ? p : other) as never,
      (name === 'openai' ? p : other) as never,
      metrics as never,
      cache as never,
      config as never,
    );
    const r = await router.route({
      system: 'Reply with exactly: OK',
      messages: [{ role: 'user', content: 'Health check. Reply with OK.' }],
      maxTokens: 5,
      timeoutMs: 15_000,
      promptVersion: 'ai-check-v1',
    });
    console.log(
      r.ok
        ? `${name}: OK model=${r.result.model} latencyMs=${r.result.latencyMs} tokensIn=${r.result.inputTokens ?? '?'} tokensOut=${r.result.outputTokens ?? '?'}`
        : `${name}: FAILED reason=${r.reason}`,
    );
  }
}
main().catch((e: unknown) => {
  console.error(
    e instanceof Error
      ? e.message.replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
      : 'failed',
  );
  process.exit(1);
});
