import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  LlmGenerateParams,
  LlmGenerateResult,
  LlmProvider,
} from './llm.provider';

/**
 * Optional fallback providers that speak the OpenAI chat-completions wire format.
 *
 * A provider exists only when BOTH its API key and its model are configured — no model id is
 * assumed, because a subscription does not imply API access to any particular model. Nothing
 * here is required for the assistant to run.
 *
 *   id          key                   model               base URL override (default)
 *   gemini      GEMINI_API_KEY        GEMINI_MODEL        GEMINI_BASE_URL     (Google's OpenAI-compatible endpoint)
 *   xai         XAI_API_KEY           XAI_MODEL           XAI_BASE_URL        (https://api.x.ai/v1)
 *   deepseek    DEEPSEEK_API_KEY      DEEPSEEK_MODEL      DEEPSEEK_BASE_URL   (https://api.deepseek.com)
 *   openrouter  OPENROUTER_API_KEY    OPENROUTER_MODEL    OPENROUTER_BASE_URL (https://openrouter.ai/api/v1)
 */
export const COMPATIBLE_PROVIDERS = [
  {
    id: 'gemini',
    env: 'GEMINI',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  },
  { id: 'xai', env: 'XAI', baseUrl: 'https://api.x.ai/v1' },
  { id: 'deepseek', env: 'DEEPSEEK', baseUrl: 'https://api.deepseek.com' },
  {
    id: 'openrouter',
    env: 'OPENROUTER',
    baseUrl: 'https://openrouter.ai/api/v1',
  },
] as const;

export class OpenAiCompatibleProvider implements LlmProvider {
  private readonly logger: Logger;

  constructor(
    readonly providerId: string,
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly model: string,
  ) {
    this.logger = new Logger(`LlmProvider:${providerId}`);
  }

  isAvailable(): boolean {
    return !!this.apiKey && !!this.model;
  }

  /** Configured model id (for status only). */
  modelId(): string {
    return this.model;
  }

  async generate(params: LlmGenerateParams): Promise<LlmGenerateResult> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      params.timeoutMs ?? 25_000,
    );
    const onAbort = () => controller.abort();
    params.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            ...(params.system
              ? [{ role: 'system', content: params.system }]
              : []),
            ...params.messages
              .filter((m) => m.role !== 'system')
              .map((m) => ({ role: m.role, content: m.content })),
          ],
          max_tokens: params.maxTokens ?? 1024,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        // Status only: an error body can echo request content.
        this.logger.warn(`HTTP ${res.status}`);
        throw new Error(`${this.providerId} HTTP ${res.status}`);
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = json.choices?.[0]?.message?.content?.trim() ?? '';
      if (!text) throw new Error(`${this.providerId} empty completion`);
      // Delivered whole: these fallbacks do not stream.
      try {
        params.onTextDelta?.(text);
      } catch {
        // ignore
      }
      return {
        text,
        provider: this.providerId,
        model: this.model,
        latencyMs: Date.now() - started,
        promptVersion: params.promptVersion,
        inputTokens: json.usage?.prompt_tokens,
        outputTokens: json.usage?.completion_tokens,
      };
    } finally {
      clearTimeout(timer);
      params.signal?.removeEventListener('abort', onAbort);
    }
  }
}

@Injectable()
export class CompatibleLlmProviders {
  private readonly providers: OpenAiCompatibleProvider[] = [];

  constructor(config: ConfigService) {
    for (const p of COMPATIBLE_PROVIDERS) {
      const key = config.get<string>(`${p.env}_API_KEY`)?.trim() ?? '';
      const model = config.get<string>(`${p.env}_MODEL`)?.trim() ?? '';
      if (!key || !model) continue;
      const base = (
        config.get<string>(`${p.env}_BASE_URL`)?.trim() || p.baseUrl
      ).replace(/\/+$/, '');
      this.providers.push(new OpenAiCompatibleProvider(p.id, key, base, model));
    }
  }

  list(): OpenAiCompatibleProvider[] {
    return this.providers;
  }
}
