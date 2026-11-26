import { Global, Module } from '@nestjs/common';
import { AnthropicLlmProvider } from './anthropic-llm.provider';
import { OpenAiLlmProvider } from './openai-llm.provider';
import { LlmRouterService } from './llm-router.service';
import { CompatibleLlmProviders } from './compatible-llm.providers';

@Global()
@Module({
  providers: [
    AnthropicLlmProvider,
    OpenAiLlmProvider,
    CompatibleLlmProviders,
    LlmRouterService,
  ],
  exports: [AnthropicLlmProvider, OpenAiLlmProvider, LlmRouterService],
})
export class AiModule {}
