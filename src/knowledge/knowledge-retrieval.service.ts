import { Injectable } from '@nestjs/common';
import { KnowledgeStatus, KnowledgeVisibility, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { neutralizePromptInjection } from './prompt-injection.util';

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

@Injectable()
export class KnowledgeRetrievalService {
  constructor(private readonly prisma: PrismaService) {}

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

    const chunks = await this.prisma.knowledgeChunk.findMany({
      where: {
        tenantId: params.tenantId,
        AND: [
          {
            OR: [
              { locationId: null },
              ...(params.locationId ? [{ locationId: params.locationId }] : []),
            ],
          },
          { OR: contentOr },
        ],
        document: {
          tenantId: params.tenantId,
          status: { in: statuses },
          ...(visibility ? { visibility } : {}),
          AND: [
            {
              OR: [{ effectiveAt: null }, { effectiveAt: { lte: now } }],
            },
            {
              OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
            },
          ],
        },
      },
      include: {
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
      },
      take: (params.limit ?? MAX_RESULTS) * 3,
    });

    // Hybrid score: lexical relevance dominates; authority, recency, location relevance and
    // document state break ties. (Semantic similarity joins when an embedding provider is
    // enabled — see embedding.provider.ts; it is optional and off by default.)
    const scored = chunks
      .map((chunk) => {
        const lower = chunk.content.toLowerCase();
        const hits = keywords.filter((kw) => lower.includes(kw)).length;
        const lexical = hits / keywords.length;
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
        const score =
          lexical * 0.6 +
          phrase +
          authority * 0.15 +
          recency * 0.1 +
          locationMatch * 0.1 +
          state * 0.05;
        return { chunk, score, lexical };
      })
      .filter((r) => r.lexical >= RELEVANCE_THRESHOLD)
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
