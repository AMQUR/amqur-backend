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
};

export interface LlmProvider {
  readonly providerId: string;
  isAvailable(): boolean;
  generate(params: LlmGenerateParams): Promise<LlmGenerateResult>;
}
