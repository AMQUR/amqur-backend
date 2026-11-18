import { Global, Module } from '@nestjs/common';
import { KnowledgeChunkerService } from './knowledge-chunker.service';
import { KnowledgeIngestionService } from './knowledge-ingestion.service';
import { KnowledgeRetrievalService } from './knowledge-retrieval.service';
import { KnowledgeService } from './knowledge.service';
import { KnowledgeController } from './knowledge.controller';
import { WebsiteIngestionService } from './website-ingestion.service';
import {
  createEmbeddingProvider,
  EMBEDDING_PROVIDER,
} from './embedding.provider';
import { KnowledgeEmbeddingService } from './knowledge-embedding.service';
import { KnowledgeLifecycleService } from './knowledge-lifecycle.service';

@Global()
@Module({
  controllers: [KnowledgeController],
  providers: [
    KnowledgeChunkerService,
    KnowledgeIngestionService,
    KnowledgeRetrievalService,
    KnowledgeService,
    WebsiteIngestionService,
    KnowledgeLifecycleService,
    KnowledgeEmbeddingService,
    {
      provide: EMBEDDING_PROVIDER,
      useFactory: () => createEmbeddingProvider(),
    },
  ],
  exports: [
    KnowledgeChunkerService,
    KnowledgeIngestionService,
    KnowledgeRetrievalService,
    KnowledgeService,
    WebsiteIngestionService,
    KnowledgeLifecycleService,
    KnowledgeEmbeddingService,
  ],
})
export class KnowledgeModule {}
