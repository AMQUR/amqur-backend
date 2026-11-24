/** Model-provider abstraction — primary/fallback without locking business logic to one vendor. */
export type LlmMessage = {
  role: 'user' | 'assistant' | 'system';
  content: string;
};

export type LlmGenerateParams = {
  messages: LlmMessage[];
  system?: string;
  maxTokens?: number;
  timeoutMs?: number;
  promptVersion?: string;
  /** Tenant the call is made for — per-tenant spend cap and attribution. Not sent to providers. */
  tenantId?: string;
  /** Model for this call (task-based routing). Providers that do not serve it use their default. */
  model?: string;
  /** Reasoning depth for models that support it. */
  effort?: 'low' | 'medium' | 'high';
  /**
   * Called with each piece of visible reply text as the model produces it. When set, the
   * provider streams. `reset` is true when text already emitted must be discarded (the call
   * restarted on another model).
   */
  onTextDelta?: (text: string, reset?: boolean) => void;
  /** Deterministic server-side tools the model may call during this one reply. */
  localTools?: LlmLocalTool[];
  /** Aborts the provider request (client pressed Stop / turn cancelled). */
  signal?: AbortSignal;
};

/** A read-only server function the model can call (calculator, payment math, inventory read). */
export type LlmLocalTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (input: Record<string, unknown>) => string | Promise<string>;
};

export type LlmGenerateResult = {
  text: string;
  provider: string;
  model: string;
  latencyMs: number;
  promptVersion?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Metered cost in micro-USD when the owner configured per-token prices. */
  costMicroUsd?: number;
  /** Names of local tools the model called while producing this reply. */
  toolsUsed?: string[];
  /** Why generation ended, when the provider reports it (e.g. 'refusal', 'max_tokens'). */
  stopReason?: string;
};

export interface LlmProvider {
  readonly providerId: string;
  isAvailable(): boolean;
  generate(params: LlmGenerateParams): Promise<LlmGenerateResult>;
}
