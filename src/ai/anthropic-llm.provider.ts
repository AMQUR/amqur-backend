import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import type {
  LlmGenerateParams,
  LlmGenerateResult,
  LlmProvider,
} from './llm.provider';

@Injectable()
export class AnthropicLlmProvider implements LlmProvider {
  readonly providerId = 'anthropic';
  private readonly logger = new Logger(AnthropicLlmProvider.name);
  private client: Anthropic | null = null;

  constructor(private readonly config: ConfigService) {
    const key = this.config.get<string>('ANTHROPIC_API_KEY');
    if (key) this.client = new Anthropic({ apiKey: key });
  }

  isAvailable(): boolean {
    return !!this.client;
  }

  async generate(params: LlmGenerateParams): Promise<LlmGenerateResult> {
    if (!this.client) {
      throw new Error('Anthropic LLM unavailable');
    }
    const model =
      this.config.get<string>('ANTHROPIC_MODEL') ?? 'claude-sonnet-5-5';
    const started = Date.now();
    const system =
      params.system ??
      'You polish dealership assistant drafts. Never invent inventory, prices, appointments, or policies.';
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      params.timeoutMs ?? 12_000,
    );
    let msg: Awaited<ReturnType<Anthropic['messages']['create']>> & {
      content: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    try {
      msg = (await this.client.messages.create(
        {
          model,
          max_tokens: params.maxTokens ?? 1024,
          system,
          messages: params.messages
            .filter((m) => m.role !== 'system')
            .map((m) => ({
              role: m.role as 'user' | 'assistant',
              content: m.content,
            })),
        },
        { signal: controller.signal, maxRetries: 0 },
      )) as typeof msg;
    } finally {
      clearTimeout(timer);
    }
    const text = msg.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n');
    return {
      text,
      provider: this.providerId,
      model,
      latencyMs: Date.now() - started,
      promptVersion: params.promptVersion,
      inputTokens: msg.usage?.input_tokens,
      outputTokens: msg.usage?.output_tokens,
    };
  }
}
