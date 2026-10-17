import { Global, Module } from '@nestjs/common';
import { KnowledgeChunkerService } from './knowledge-chunker.service';
import { KnowledgeIngestionService } from './knowledge-ingestion.service';
import { KnowledgeRetrievalService } from './knowledge-retrieval.service';
import { KnowledgeService } from './knowledge.service';
import { KnowledgeController } from './knowledge.controller';
import { WebsiteIngestionService } from './website-ingestion.service';
import { DisabledEmbeddingProvider } from './embedding.provider';
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
    { provide: 'EmbeddingProvider', useClass: DisabledEmbeddingProvider },
  ],
  exports: [
    KnowledgeChunkerService,
    KnowledgeIngestionService,
    KnowledgeRetrievalService,
    KnowledgeService,
    WebsiteIngestionService,
    KnowledgeLifecycleService,
  ],
})
export class KnowledgeModule {}
