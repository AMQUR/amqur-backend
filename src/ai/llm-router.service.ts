import { Injectable, Logger } from '@nestjs/common';
import { AnthropicLlmProvider } from './anthropic-llm.provider';
import type { LlmGenerateParams, LlmGenerateResult } from './llm.provider';
import { MetricsService } from '../observability/metrics.service';

/**
 * Routes LLM calls with graceful degradation.
 * Non-LLM paths (inventory, leads, handoff) must remain usable when this fails.
 */
@Injectable()
export class LlmRouterService {
  private readonly logger = new Logger(LlmRouterService.name);

  constructor(
    private readonly primary: AnthropicLlmProvider,
    private readonly metrics: MetricsService,
  ) {}

  isAvailable(): boolean {
    return this.primary.isAvailable();
  }

  async generate(
    params: LlmGenerateParams,
  ): Promise<LlmGenerateResult | null> {
    if (!this.primary.isAvailable()) {
      this.metrics.increment('ai.llm.unavailable');
      return null;
    }
    try {
      const result = await this.primary.generate(params);
      this.metrics.increment('ai.llm.success');
      return result;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`LLM generate failed: ${msg}`);
      this.metrics.increment('ai.llm.failure');
      return null;
    }
  }
}
