import { Global, Module } from '@nestjs/common';
import { AnthropicLlmProvider } from './anthropic-llm.provider';
import { LlmRouterService } from './llm-router.service';

@Global()
@Module({
  providers: [AnthropicLlmProvider, LlmRouterService],
  exports: [AnthropicLlmProvider, LlmRouterService],
})
export class AiModule {}
