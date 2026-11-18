import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  EMBEDDING_PROVIDER,
  type EmbeddingProvider,
} from './embedding.provider';

const BATCH = 32;

/**
 * Incremental, idempotent embedding of knowledge chunks. Tenant-scoped; selects only chunks
 * with no vector or a vector from a different model, so re-running is safe.
 */
@Injectable()
export class KnowledgeEmbeddingService {
  private readonly logger = new Logger(KnowledgeEmbeddingService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(EMBEDDING_PROVIDER) private readonly provider: EmbeddingProvider,
  ) {}

  async embedPending(
    tenantId: string,
    opts: { limit?: number } = {},
  ): Promise<{ embedded: number; skipped?: 'provider_disabled' }> {
    if (!this.provider.isAvailable())
      return { embedded: 0, skipped: 'provider_disabled' };
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
    let embedded = 0;
    while (embedded < limit) {
      const pending = await this.prisma.knowledgeChunk.findMany({
        where: {
          tenantId,
          OR: [
            { embeddingModel: null },
            { embeddingModel: { not: this.provider.modelId } },
          ],
        },
        select: { id: true, content: true },
        orderBy: { createdAt: 'asc' },
        take: Math.min(BATCH, limit - embedded),
      });
      if (pending.length === 0) break;
      let vectors;
      try {
        vectors = await this.provider.embed(pending.map((c) => c.content));
      } catch (err: unknown) {
        this.logger.warn(
          `embedding batch failed tenant=${tenantId} err=${err instanceof Error ? err.name : 'unknown'}`,
        );
        break;
      }
      if (vectors.length !== pending.length) break;
      for (let i = 0; i < pending.length; i += 1) {
        await this.prisma.knowledgeChunk.update({
          where: { id: pending[i].id },
          data: {
            embedding: vectors[i].vector as unknown as Prisma.InputJsonValue,
            embeddingModel: this.provider.modelId,
          },
        });
      }
      embedded += pending.length;
    }
    return { embedded };
  }
}
