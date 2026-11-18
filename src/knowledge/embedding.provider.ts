/**
 * Embedding provider abstraction. Keyword retrieval remains the production baseline;
 * vectors are optional, tenant-scoped, and fail closed when the provider is disabled.
 */
export type EmbeddingResult = {
  model: string;
  dimensions: number;
  vector: number[];
};

export interface EmbeddingProvider {
  readonly providerId: string;
  /** Model identifier stamped on stored vectors; vectors from other models are never compared. */
  readonly modelId: string;
  isAvailable(): boolean;
  embed(texts: string[]): Promise<EmbeddingResult[]>;
}

export const EMBEDDING_PROVIDER = 'EmbeddingProvider';

/** Fail-closed stub used unless embeddings are explicitly enabled with a server-side key. */
export class DisabledEmbeddingProvider implements EmbeddingProvider {
  readonly providerId = 'disabled';
  readonly modelId = 'disabled';
  isAvailable(): boolean {
    return false;
  }
  async embed(_texts: string[]): Promise<EmbeddingResult[]> {
    return [];
  }
}

const MAX_INPUT_CHARS = 8000;
const MAX_BATCH = 64;

/** OpenAI-compatible embeddings endpoint. Key is read server-side only, never logged. */
export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly providerId = 'openai';

  constructor(
    private readonly apiKey: string,
    readonly modelId: string,
    private readonly baseUrl = 'https://api.openai.com/v1',
    private readonly timeoutMs = 15_000,
  ) {}

  isAvailable(): boolean {
    return this.apiKey.length > 0;
  }

  async embed(texts: string[]): Promise<EmbeddingResult[]> {
    if (!this.isAvailable() || texts.length === 0) return [];
    if (texts.length > MAX_BATCH) throw new Error('embedding batch too large');
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.modelId,
        input: texts.map((t) => t.slice(0, MAX_INPUT_CHARS)),
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok)
      throw new Error(`embedding request failed status=${res.status}`);
    const body = (await res.json()) as {
      data?: Array<{ index: number; embedding: number[] }>;
    };
    const data = [...(body.data ?? [])].sort((a, b) => a.index - b.index);
    if (data.length !== texts.length)
      throw new Error('embedding count mismatch');
    return data.map((d) => ({
      model: this.modelId,
      dimensions: d.embedding.length,
      vector: d.embedding,
    }));
  }
}

/** Embeddings are OFF unless KNOWLEDGE_EMBEDDINGS_ENABLED=true and OPENAI_API_KEY is set. */
export function createEmbeddingProvider(
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingProvider {
  const key = env.OPENAI_API_KEY?.trim() ?? '';
  if (env.KNOWLEDGE_EMBEDDINGS_ENABLED !== 'true' || !key)
    return new DisabledEmbeddingProvider();
  return new OpenAiEmbeddingProvider(
    key,
    env.KNOWLEDGE_EMBEDDING_MODEL?.trim() || 'text-embedding-3-small',
  );
}
