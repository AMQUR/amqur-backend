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
};

export type LlmGenerateResult = {
  text: string;
  provider: string;
  model: string;
  latencyMs: number;
  promptVersion?: string;
};

export interface LlmProvider {
  readonly providerId: string;
  isAvailable(): boolean;
  generate(params: LlmGenerateParams): Promise<LlmGenerateResult>;
}
