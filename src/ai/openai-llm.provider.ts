import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  LlmGenerateParams,
  LlmGenerateResult,
  LlmProvider,
} from './llm.provider';

/**
 * OpenAI-compatible chat completions adapter.
 * Uses fetch against the official API — no invented business endpoints.
 * Disabled when OPENAI_API_KEY is unset.
 */
@Injectable()
export class OpenAiLlmProvider implements LlmProvider {
  readonly providerId = 'openai';
  private readonly logger = new Logger(OpenAiLlmProvider.name);
  private readonly apiKey: string | null;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(private readonly config: ConfigService) {
    const key = this.config.get<string>('OPENAI_API_KEY')?.trim() ?? '';
    this.apiKey = key.length > 0 ? key : null;
    this.baseUrl = (
      this.config.get<string>('OPENAI_BASE_URL') ?? 'https://api.openai.com/v1'
    ).replace(/\/$/, '');
    this.model = this.config.get<string>('OPENAI_MODEL') ?? 'gpt-4o-mini';
    this.timeoutMs = Number(
      this.config.get<string>('OPENAI_TIMEOUT_MS') ?? 25000,
    );
  }

  isAvailable(): boolean {
    return !!this.apiKey;
  }

  async generate(params: LlmGenerateParams): Promise<LlmGenerateResult> {
    if (!this.apiKey) {
      throw new Error('OpenAI LLM unavailable');
    }
    const started = Date.now();
    const system =
      params.system ??
      'You polish dealership assistant drafts. Never invent inventory, prices, appointments, or policies.';
    const messages = [
      { role: 'system', content: system },
      ...params.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role, content: m.content })),
    ];

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      params.timeoutMs ?? this.timeoutMs,
    );
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          // Current OpenAI models reject `max_tokens` and fixed sampling; the completion
          // budget also covers hidden reasoning tokens, so leave headroom above the visible cap.
          max_completion_tokens: Math.max((params.maxTokens ?? 1024) * 4, 2000),
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        // Status only: an error body can echo request content.
        this.logger.warn(`OpenAI HTTP ${res.status}`);
        throw new Error(`OpenAI HTTP ${res.status}`);
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = json.choices?.[0]?.message?.content?.trim() ?? '';
      if (!text) throw new Error('OpenAI empty completion');
      // Delivered whole: this fallback does not stream.
      try {
        params.onTextDelta?.(text);
      } catch {
        // ignore
      }
      return {
        inputTokens: json.usage?.prompt_tokens,
        outputTokens: json.usage?.completion_tokens,
        text,
        provider: this.providerId,
        model: this.model,
        latencyMs: Date.now() - started,
        promptVersion: params.promptVersion,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
