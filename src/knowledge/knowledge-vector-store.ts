import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export const PGVECTOR_DIMENSIONS = 1536;

export type NearestParams = {
  tenantId: string;
  vector: number[];
  statuses: string[];
  customerOnly: boolean;
  limit: number;
};

/**
 * Optional pgvector accelerator. Active only when KNOWLEDGE_PGVECTOR_ENABLED=true AND the
 * guarded migration actually created "embeddingVec". Any failure degrades to the existing
 * retrieval path; it never widens access (callers still re-apply Prisma visibility filters).
 */
@Injectable()
export class KnowledgeVectorStore {
  private readonly logger = new Logger(KnowledgeVectorStore.name);
  private available: boolean | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async isEnabled(): Promise<boolean> {
    if (process.env.KNOWLEDGE_PGVECTOR_ENABLED !== 'true') return false;
    if (this.available !== null) return this.available;
    try {
      const rows = await this.prisma.$queryRaw<Array<{ ok: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'KnowledgeChunk' AND column_name = 'embeddingVec'
        ) AS ok`;
      this.available = rows[0]?.ok === true;
    } catch {
      this.available = false;
    }
    return this.available;
  }

  private literal(vector: number[]): string {
    return `[${vector.join(',')}]`;
  }

  /** Best-effort mirror of a JSON embedding into the vector column. */
  async store(
    chunkId: string,
    tenantId: string,
    vector: number[],
  ): Promise<void> {
    if (vector.length !== PGVECTOR_DIMENSIONS || !(await this.isEnabled()))
      return;
    if (!vector.every(Number.isFinite)) return;
    try {
      await this.prisma.$executeRaw`
        UPDATE "KnowledgeChunk"
        SET "embeddingVec" = ${this.literal(vector)}::vector
        WHERE id = ${chunkId} AND "tenantId" = ${tenantId}`;
    } catch (err: unknown) {
      this.logger.warn(
        `vector mirror failed err=${err instanceof Error ? err.name : 'unknown'}`,
      );
    }
  }

  /** Nearest chunk ids for one tenant, pre-filtered by document status/visibility/window. */
  async nearest(p: NearestParams): Promise<string[] | null> {
    if (p.vector.length !== PGVECTOR_DIMENSIONS || !(await this.isEnabled()))
      return null;
    if (!p.vector.every(Number.isFinite)) return null;
    try {
      const rows = await this.prisma.$queryRaw<
        Array<{ id: string }>
      >(Prisma.sql`
        SELECT c.id
        FROM "KnowledgeChunk" c
        JOIN "KnowledgeDocument" d ON d.id = c."documentId"
        WHERE c."tenantId" = ${p.tenantId}
          AND d."tenantId" = ${p.tenantId}
          AND c."embeddingVec" IS NOT NULL
          AND d.status::text = ANY(${p.statuses})
          ${p.customerOnly ? Prisma.sql`AND d.visibility::text = 'CUSTOMER'` : Prisma.empty}
          AND (d."effectiveAt" IS NULL OR d."effectiveAt" <= now())
          AND (d."expiresAt" IS NULL OR d."expiresAt" > now())
        ORDER BY c."embeddingVec" <=> ${this.literal(p.vector)}::vector
        LIMIT ${p.limit}`);
      return rows.map((r) => r.id);
    } catch (err: unknown) {
      this.logger.warn(
        `vector search failed err=${err instanceof Error ? err.name : 'unknown'}`,
      );
      return null;
    }
  }
}
