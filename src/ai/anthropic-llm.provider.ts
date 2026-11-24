import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import type {
  LlmGenerateParams,
  LlmGenerateResult,
  LlmProvider,
} from './llm.provider';

/** Tool round-trips allowed inside one reply (calculator → answer is one). */
const MAX_TOOL_ROUNDS = 4;

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
      params.model?.trim() ||
      (this.config.get<string>('ANTHROPIC_MODEL') ?? 'claude-sonnet-5-5');
    const started = Date.now();
    const system =
      params.system ??
      'You polish dealership assistant drafts. Never invent inventory, prices, appointments, or policies.';
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      params.timeoutMs ?? 12_000,
    );
    const onAbort = () => controller.abort();
    params.signal?.addEventListener('abort', onAbort, { once: true });
    if (params.signal?.aborted) controller.abort();

    const tools: Anthropic.Tool[] | undefined = params.localTools?.length
      ? params.localTools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
        }))
      : undefined;
    const messages: Anthropic.MessageParam[] = params.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));
    const base = {
      model,
      max_tokens: params.maxTokens ?? 1024,
      system,
      ...(params.effort ? { output_config: { effort: params.effort } } : {}),
      ...(tools ? { tools } : {}),
    };

    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: string | undefined;
    const toolsUsed: string[] = [];
    try {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
        let msg: Anthropic.Message;
        if (params.onTextDelta) {
          const stream = this.client.messages.stream(
            { ...base, messages },
            { signal: controller.signal, maxRetries: 0 },
          );
          stream.on('text', (delta) => {
            try {
              params.onTextDelta?.(delta);
            } catch {
              // a listener must never break generation
            }
          });
          msg = await stream.finalMessage();
        } else {
          msg = await this.client.messages.create(
            { ...base, messages },
            { signal: controller.signal, maxRetries: 0 },
          );
        }
        inputTokens += msg.usage?.input_tokens ?? 0;
        outputTokens += msg.usage?.output_tokens ?? 0;
        stopReason = msg.stop_reason ?? undefined;
        const roundText = msg.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('');
        text += roundText;
        const calls = msg.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
        );
        if (msg.stop_reason !== 'tool_use' || !calls.length) break;
        if (round === MAX_TOOL_ROUNDS) break;
        // Echo the assistant turn unchanged (thinking blocks included), then answer every call.
        messages.push({ role: 'assistant', content: msg.content });
        const results: Anthropic.ToolResultBlockParam[] = calls.map((c) => {
          const tool = params.localTools?.find((t) => t.name === c.name);
          toolsUsed.push(c.name);
          if (!tool)
            return {
              type: 'tool_result',
              tool_use_id: c.id,
              content: 'Unknown tool.',
              is_error: true,
            };
          try {
            return {
              type: 'tool_result',
              tool_use_id: c.id,
              content: tool.run((c.input ?? {}) as Record<string, unknown>),
            };
          } catch (e: unknown) {
            return {
              type: 'tool_result',
              tool_use_id: c.id,
              content: `Error: ${e instanceof Error ? e.message.slice(0, 200) : 'invalid input'}`,
              is_error: true,
            };
          }
        });
        messages.push({ role: 'user', content: results });
        // Text spoken before a tool call is followed by more text: keep a paragraph break.
        if (roundText.trim()) {
          text += '\n\n';
          try {
            params.onTextDelta?.('\n\n');
          } catch {
            // ignore
          }
        }
      }
    } finally {
      clearTimeout(timer);
      params.signal?.removeEventListener('abort', onAbort);
    }
    return {
      text,
      provider: this.providerId,
      model,
      latencyMs: Date.now() - started,
      promptVersion: params.promptVersion,
      inputTokens,
      outputTokens,
      toolsUsed: toolsUsed.length ? toolsUsed : undefined,
      stopReason,
    };
  }
}
