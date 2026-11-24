import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  LlmGenerateParams,
  LlmGenerateResult,
  LlmProvider,
} from './llm.provider';

/** Tool round-trips allowed inside one reply (same bound as the Anthropic provider). */
const MAX_TOOL_ROUNDS = 4;

type ToolCall = { id: string; name: string; arguments: string };
type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

type ResponseItem = {
  type?: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type?: string; text?: string }>;
};
type ResponseBody = {
  status?: string;
  output?: ResponseItem[];
  usage?: { input_tokens?: number; output_tokens?: number };
};

type Round = {
  text: string;
  calls: ToolCall[];
  finish: string | undefined;
  inputTokens: number;
  outputTokens: number;
};

/**
 * OpenAI chat-completions provider with the same contract as the Anthropic one: per-call model,
 * token streaming, and a bounded loop over deterministic local tools. Which provider is primary
 * must not decide which product features exist.
 *
 * Uses fetch against the official API — no invented endpoints. Disabled when OPENAI_API_KEY is
 * unset.
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
    const model = params.model?.trim() || this.model;
    const system =
      params.system ??
      'You polish dealership assistant drafts. Never invent inventory, prices, appointments, or policies.';
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      ...params.messages
        .filter((m) => m.role !== 'system')
        .map(
          (m): ChatMessage =>
            m.role === 'assistant'
              ? { role: 'assistant', content: m.content }
              : { role: 'user', content: m.content },
        ),
    ];
    const tools = params.localTools?.length
      ? params.localTools.map((t) => ({
          type: 'function' as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          },
        }))
      : undefined;

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      params.timeoutMs ?? this.timeoutMs,
    );
    const onAbort = () => controller.abort();
    params.signal?.addEventListener('abort', onAbort, { once: true });
    if (params.signal?.aborted) controller.abort();

    // Current reasoning models accept function tools only on the Responses endpoint
    // ("Function tools with reasoning_effort are not supported … in /v1/chat/completions").
    // Tool-enabled calls therefore use it; plain calls stay on chat completions.
    if (tools && this.useResponses()) {
      try {
        return await this.generateWithResponses(
          params,
          model,
          system,
          controller.signal,
          started,
        );
      } finally {
        clearTimeout(timer);
        params.signal?.removeEventListener('abort', onAbort);
      }
    }

    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: string | undefined;
    const toolsUsed: string[] = [];
    try {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
        const body = {
          model,
          messages,
          // Current OpenAI models reject `max_tokens` and fixed sampling; the completion
          // budget also covers hidden reasoning tokens, so leave headroom above the visible cap.
          max_completion_tokens: Math.max((params.maxTokens ?? 1024) * 4, 2000),
          ...(tools ? { tools } : {}),
        };
        const r = params.onTextDelta
          ? await this.streamRound(body, controller.signal, params.onTextDelta)
          : await this.plainRound(body, controller.signal);
        inputTokens += r.inputTokens;
        outputTokens += r.outputTokens;
        stopReason = r.finish;
        text += r.text;
        if (!r.calls.length || round === MAX_TOOL_ROUNDS) break;

        messages.push({
          role: 'assistant',
          content: r.text || null,
          tool_calls: r.calls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: c.arguments },
          })),
        });
        const results = await Promise.all(
          r.calls.map(async (c): Promise<ChatMessage> => {
            const tool = params.localTools?.find((t) => t.name === c.name);
            toolsUsed.push(c.name);
            if (!tool)
              return {
                role: 'tool',
                tool_call_id: c.id,
                content: 'Error: unknown tool.',
              };
            try {
              // Arguments are model output: parse defensively, never trust the shape.
              const parsed: unknown = c.arguments.trim()
                ? JSON.parse(c.arguments)
                : {};
              const input =
                parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                  ? (parsed as Record<string, unknown>)
                  : {};
              return {
                role: 'tool',
                tool_call_id: c.id,
                content: await tool.run(input),
              };
            } catch (e: unknown) {
              return {
                role: 'tool',
                tool_call_id: c.id,
                content: `Error: ${e instanceof Error ? e.message.slice(0, 200) : 'invalid input'}`,
              };
            }
          }),
        );
        messages.push(...results);
        // Whatever the model wrote before calling a tool is working narration, not the
        // answer: drop it and tell the listener to discard what it has.
        if (r.text) {
          text = text.slice(0, text.length - r.text.length);
          try {
            params.onTextDelta?.('', true);
          } catch {
            // ignore
          }
        }
      }
    } finally {
      clearTimeout(timer);
      params.signal?.removeEventListener('abort', onAbort);
    }
    if (!text.trim()) throw new Error('OpenAI empty completion');
    return {
      text: text.trim(),
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

  /** OPENAI_TOOLS_API=chat forces chat completions for tools (OpenAI-compatible vendors). */
  private useResponses(): boolean {
    const forced = this.config.get<string>('OPENAI_TOOLS_API')?.trim();
    if (forced === 'chat') return false;
    if (forced === 'responses') return true;
    return /(^|\.)openai\.com$/.test(new URL(this.baseUrl).hostname);
  }

  private async generateWithResponses(
    params: LlmGenerateParams,
    model: string,
    system: string,
    signal: AbortSignal,
    started: number,
  ): Promise<LlmGenerateResult> {
    const tools = (params.localTools ?? []).map((t) => ({
      type: 'function' as const,
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    }));
    const input: unknown[] = params.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));
    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: string | undefined;
    const toolsUsed: string[] = [];
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
      const body = {
        model,
        instructions: system,
        input,
        tools,
        max_output_tokens: Math.max((params.maxTokens ?? 1024) * 4, 2000),
        store: false,
      };
      const r = await this.responsesRound(body, signal, params.onTextDelta);
      inputTokens += r.inputTokens;
      outputTokens += r.outputTokens;
      stopReason = r.status;
      text += r.text;
      const calls = r.output.filter(
        (o): o is ResponseItem & { call_id: string; name: string } =>
          o.type === 'function_call' && !!o.call_id && !!o.name,
      );
      if (!calls.length || round === MAX_TOOL_ROUNDS) break;
      // The model's own items go back unchanged, then one result per call.
      input.push(...r.output.filter((o) => o.type === 'function_call'));
      const results = await Promise.all(
        calls.map(async (c) => {
          const tool = params.localTools?.find((t) => t.name === c.name);
          toolsUsed.push(c.name);
          let output: string;
          if (!tool) output = 'Error: unknown tool.';
          else
            try {
              // Arguments are model output: parse defensively, never trust the shape.
              const parsed: unknown = (c.arguments ?? '').trim()
                ? JSON.parse(c.arguments as string)
                : {};
              output = await tool.run(
                parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                  ? (parsed as Record<string, unknown>)
                  : {},
              );
            } catch (e: unknown) {
              output = `Error: ${e instanceof Error ? e.message.slice(0, 200) : 'invalid input'}`;
            }
          return { type: 'function_call_output', call_id: c.call_id, output };
        }),
      );
      input.push(...results);
      // Narration written before a tool call is not the answer.
      if (r.text) {
        text = text.slice(0, text.length - r.text.length);
        try {
          params.onTextDelta?.('', true);
        } catch {
          // ignore
        }
      }
    }
    if (!text.trim()) throw new Error('OpenAI empty completion');
    return {
      text: text.trim(),
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

  private async responsesRound(
    body: object,
    signal: AbortSignal,
    onTextDelta?: (text: string, reset?: boolean) => void,
  ): Promise<{
    text: string;
    output: ResponseItem[];
    status: string | undefined;
    inputTokens: number;
    outputTokens: number;
  }> {
    const res = await fetch(`${this.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(onTextDelta ? { ...body, stream: true } : body),
      signal,
    });
    if (!res.ok) {
      this.logger.warn(`OpenAI responses HTTP ${res.status}`);
      throw new Error(`OpenAI HTTP ${res.status}`);
    }
    const textOf = (output: ResponseItem[]) =>
      output
        .filter((o) => o.type === 'message')
        .flatMap((o) => o.content ?? [])
        .filter((c) => c.type === 'output_text')
        .map((c) => c.text ?? '')
        .join('');
    if (!onTextDelta) {
      const json = (await res.json()) as ResponseBody;
      const output = json.output ?? [];
      return {
        text: textOf(output),
        output,
        status: json.status,
        inputTokens: json.usage?.input_tokens ?? 0,
        outputTokens: json.usage?.output_tokens ?? 0,
      };
    }
    if (!res.body) throw new Error('OpenAI stream has no body');
    let streamed = '';
    let final: ResponseBody | null = null;
    let failed = false;
    const decoder = new TextDecoder();
    let buffer = '';
    const handle = (line: string) => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return;
      let event: { type?: string; delta?: string; response?: ResponseBody };
      try {
        event = JSON.parse(data) as typeof event;
      } catch {
        return;
      }
      if (event.type === 'response.output_text.delta' && event.delta) {
        streamed += event.delta;
        try {
          onTextDelta(event.delta);
        } catch {
          // a listener must never break generation
        }
      } else if (
        event.type === 'response.completed' ||
        event.type === 'response.incomplete'
      ) {
        final = event.response ?? null;
      } else if (event.type === 'response.failed' || event.type === 'error') {
        failed = true;
      }
    };
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        handle(buffer.slice(0, nl).trimEnd());
        buffer = buffer.slice(nl + 1);
      }
    }
    if (buffer.trim()) handle(buffer.trim());
    if (failed) throw new Error('OpenAI response failed');
    const done = final as ResponseBody | null;
    const output = done?.output ?? [];
    return {
      // what was streamed is what the client has; the final object fills in when nothing streamed
      text: streamed || textOf(output),
      output,
      status: done?.status,
      inputTokens: done?.usage?.input_tokens ?? 0,
      outputTokens: done?.usage?.output_tokens ?? 0,
    };
  }

  private async post(body: unknown, signal: AbortSignal): Promise<Response> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      // Status only: an error body can echo request content.
      this.logger.warn(`OpenAI HTTP ${res.status}`);
      throw new Error(`OpenAI HTTP ${res.status}`);
    }
    return res;
  }

  private async plainRound(body: object, signal: AbortSignal): Promise<Round> {
    const res = await this.post(body, signal);
    const json = (await res.json()) as {
      choices?: Array<{
        finish_reason?: string;
        message?: {
          content?: string | null;
          tool_calls?: Array<{
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = json.choices?.[0];
    return {
      text: choice?.message?.content ?? '',
      calls: (choice?.message?.tool_calls ?? [])
        .filter((c) => c.id && c.function?.name)
        .map((c) => ({
          id: c.id as string,
          name: c.function?.name as string,
          arguments: c.function?.arguments ?? '',
        })),
      finish: choice?.finish_reason,
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
    };
  }

  /** Server-sent events: text deltas go to the listener as they arrive. */
  private async streamRound(
    body: object,
    signal: AbortSignal,
    onTextDelta: (text: string, reset?: boolean) => void,
  ): Promise<Round> {
    const res = await this.post(
      { ...body, stream: true, stream_options: { include_usage: true } },
      signal,
    );
    if (!res.body) throw new Error('OpenAI stream has no body');
    const out: Round = {
      text: '',
      calls: [],
      finish: undefined,
      inputTokens: 0,
      outputTokens: 0,
    };
    const calls = new Map<number, ToolCall>();
    const decoder = new TextDecoder();
    let buffer = '';
    const handle = (line: string) => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return;
      let event: {
        choices?: Array<{
          finish_reason?: string | null;
          delta?: {
            content?: string | null;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
      };
      try {
        event = JSON.parse(data) as typeof event;
      } catch {
        return; // a malformed frame is skipped, never fatal
      }
      if (event.usage) {
        out.inputTokens = event.usage.prompt_tokens ?? out.inputTokens;
        out.outputTokens = event.usage.completion_tokens ?? out.outputTokens;
      }
      const choice = event.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) out.finish = choice.finish_reason;
      const piece = choice.delta?.content;
      if (piece) {
        out.text += piece;
        try {
          onTextDelta(piece);
        } catch {
          // a listener must never break generation
        }
      }
      for (const tc of choice.delta?.tool_calls ?? []) {
        const i = tc.index ?? 0;
        const cur = calls.get(i) ?? { id: '', name: '', arguments: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.arguments += tc.function.arguments;
        calls.set(i, cur);
      }
    };
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        handle(buffer.slice(0, nl).trimEnd());
        buffer = buffer.slice(nl + 1);
      }
    }
    if (buffer.trim()) handle(buffer.trim());
    out.calls = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, c]) => c)
      .filter((c) => c.id && c.name);
    return out;
  }
}
