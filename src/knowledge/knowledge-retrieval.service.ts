import { Inject, Injectable, Optional } from '@nestjs/common';
import { KnowledgeStatus, KnowledgeVisibility, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { neutralizePromptInjection } from './prompt-injection.util';
import {
  EMBEDDING_PROVIDER,
  type EmbeddingProvider,
} from './embedding.provider';
import { cosineSimilarity, parseStoredVector } from './vector-math';

export type KnowledgeSearchResult = {
  chunkId: string;
  documentId: string;
  title: string;
  content: string;
  score: number;
  injectionNeutralized: boolean;
  metadata?: Record<string, unknown> | null;
};

const RELEVANCE_THRESHOLD = 0.15;
const MAX_RESULTS = 10;
const SEMANTIC_THRESHOLD = 0.35;
const SEMANTIC_CANDIDATES = 400;

@Injectable()
export class KnowledgeRetrievalService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(EMBEDDING_PROVIDER)
    private readonly embedder?: EmbeddingProvider,
  ) {}

  /** Query embedding; null (lexical-only) when disabled or the provider fails. */
  private async embedQuery(q: string): Promise<number[] | null> {
    if (!this.embedder?.isAvailable()) return null;
    try {
      const [r] = await this.embedder.embed([q]);
      return r?.vector ?? null;
    } catch {
      return null;
    }
  }

  async search(params: {
    tenantId: string;
    locationId?: string | null;
    query: string;
    forWidget?: boolean;
    limit?: number;
  }): Promise<KnowledgeSearchResult[]> {
    const q = params.query.trim();
    if (!q) return [];

    const now = new Date();
    const visibility = params.forWidget
      ? KnowledgeVisibility.CUSTOMER
      : undefined;
    // Customer AI only ever retrieves PUBLISHED, CUSTOMER-visible, in-window content.
    const statuses = params.forWidget
      ? [KnowledgeStatus.PUBLISHED]
      : [
          KnowledgeStatus.PUBLISHED,
          KnowledgeStatus.APPROVED,
          KnowledgeStatus.DRAFT,
        ];

    const keywords = q
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length >= 2);

    if (keywords.length === 0) return [];

    const contentOr: Prisma.KnowledgeChunkWhereInput[] = keywords.map((kw) => ({
      content: { contains: kw, mode: 'insensitive' as const },
    }));

    const baseWhere: Prisma.KnowledgeChunkWhereInput = {
      tenantId: params.tenantId,
      document: {
        tenantId: params.tenantId,
        status: { in: statuses },
        ...(visibility ? { visibility } : {}),
        AND: [
          { OR: [{ effectiveAt: null }, { effectiveAt: { lte: now } }] },
          { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        ],
      },
    };
    const locationOr = {
      OR: [
        { locationId: null },
        ...(params.locationId ? [{ locationId: params.locationId }] : []),
      ],
    };
    const include = {
      document: {
        select: {
          id: true,
          title: true,
          metadata: true,
          status: true,
          locationId: true,
          lastVerifiedAt: true,
          updatedAt: true,
          source: { select: { authorityLevel: true } },
        },
      },
    };
    const take = (params.limit ?? MAX_RESULTS) * 3;

    const queryVector = await this.embedQuery(q);
    const lexicalChunks = await this.prisma.knowledgeChunk.findMany({
      where: { ...baseWhere, AND: [locationOr, { OR: contentOr }] },
      include,
      take,
    });
    // Semantic candidates pass through the SAME tenant/status/visibility/window filters;
    // only vectors from the current model are compared.
    const semanticChunks =
      queryVector && this.embedder
        ? await this.prisma.knowledgeChunk.findMany({
            where: {
              ...baseWhere,
              AND: [locationOr],
              embeddingModel: this.embedder.modelId,
            },
            include,
            orderBy: { updatedAt: 'desc' },
            take: SEMANTIC_CANDIDATES,
          })
        : [];
    const byId = new Map<string, (typeof lexicalChunks)[number]>();
    for (const c of lexicalChunks) byId.set(c.id, c);
    for (const c of semanticChunks) if (!byId.has(c.id)) byId.set(c.id, c);
    const chunks = [...byId.values()];

    // Hybrid score: lexical relevance dominates; authority, recency, location relevance and
    // document state break ties. (Semantic similarity joins when an embedding provider is
    // enabled — see embedding.provider.ts; it is optional and off by default.)
    const scored = chunks
      .map((chunk) => {
        const lower = chunk.content.toLowerCase();
        const hits = keywords.filter((kw) => lower.includes(kw)).length;
        const lexical = hits / keywords.length;
        const stored =
          queryVector &&
          this.embedder &&
          (chunk as { embeddingModel?: string | null }).embeddingModel ===
            this.embedder.modelId
            ? parseStoredVector((chunk as { embedding?: unknown }).embedding)
            : null;
        const semantic = stored
          ? Math.max(0, cosineSimilarity(queryVector!, stored))
          : 0;
        const phrase =
          keywords.length > 1 && lower.includes(keywords.join(' ')) ? 0.15 : 0;
        const doc = chunk.document as typeof chunk.document & {
          status?: string;
          locationId?: string | null;
          lastVerifiedAt?: Date | null;
          updatedAt?: Date;
          source?: { authorityLevel?: string } | null;
        };
        const authority =
          { AUTHORITATIVE: 1, APPROVED: 0.75, REVIEWED: 0.5, UNVERIFIED: 0.2 }[
            doc.source?.authorityLevel ?? 'APPROVED'
          ] ?? 0.5;
        const ts = (doc.lastVerifiedAt ?? doc.updatedAt)?.getTime?.() ?? 0;
        const ageDays = ts ? (Date.now() - ts) / 86_400_000 : 365;
        const recency = Math.max(0, 1 - ageDays / 365);
        const locationMatch =
          params.locationId &&
          (chunk.locationId === params.locationId ||
            doc.locationId === params.locationId)
            ? 1
            : 0;
        const state = doc.status === 'PUBLISHED' ? 1 : 0.3;
        const lexWeight = stored ? 0.3 : 0.6;
        const score =
          lexical * lexWeight +
          semantic * (stored ? 0.3 : 0) +
          phrase +
          authority * 0.15 +
          recency * 0.1 +
          locationMatch * 0.1 +
          state * 0.05;
        return { chunk, score, lexical, semantic };
      })
      .filter(
        (r) =>
          r.lexical >= RELEVANCE_THRESHOLD || r.semantic >= SEMANTIC_THRESHOLD,
      )
      .sort((a, b) => b.score - a.score)
      .slice(0, params.limit ?? MAX_RESULTS);

    return scored.map(({ chunk, score }) => {
      const neutralized = neutralizePromptInjection(chunk.content);
      return {
        chunkId: chunk.id,
        documentId: chunk.documentId,
        title: chunk.document.title,
        content: neutralized.text,
        score,
        injectionNeutralized: neutralized.injectionDetected,
        metadata: {
          ...(typeof chunk.metadata === 'object' && chunk.metadata !== null
            ? (chunk.metadata as Record<string, unknown>)
            : {}),
          ...(typeof chunk.document.metadata === 'object' &&
          chunk.document.metadata !== null
            ? (chunk.document.metadata as Record<string, unknown>)
            : {}),
          treatAsData: true,
        },
      };
    });
  }
}
