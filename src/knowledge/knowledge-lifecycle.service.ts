import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { KnowledgeStatus, KnowledgeVisibility, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { KnowledgeIngestionService } from './knowledge-ingestion.service';
import { KnowledgeChunkerService } from './knowledge-chunker.service';
import { KnowledgeRetrievalService } from './knowledge-retrieval.service';
import { WebsiteIngestionService } from './website-ingestion.service';

const FLOW: Record<KnowledgeStatus, KnowledgeStatus[]> = {
  DRAFT: ['PENDING_REVIEW', 'APPROVED', 'ARCHIVED'],
  PENDING_REVIEW: ['APPROVED', 'REJECTED', 'DRAFT', 'ARCHIVED'],
  APPROVED: ['PUBLISHED', 'DRAFT', 'ARCHIVED'],
  PUBLISHED: ['APPROVED', 'ARCHIVED', 'EXPIRED'], // unpublish = back to APPROVED
  EXPIRED: ['DRAFT', 'ARCHIVED'],
  REJECTED: ['DRAFT', 'ARCHIVED'],
  ARCHIVED: [],
};

/**
 * Staff knowledge workflow: create → edit → review → approve → publish/unpublish → archive,
 * with visibility (CUSTOMER/STAFF/INTERNAL), tenant/location scope, effective/expiry windows,
 * last-verified dates and a customer-retrieval preview. Editing published content creates a
 * new version back in DRAFT so unreviewed text is never served to customers.
 */
@Injectable()
export class KnowledgeLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ingestion: KnowledgeIngestionService,
    private readonly chunker: KnowledgeChunkerService,
    private readonly retrieval: KnowledgeRetrievalService,
    private readonly website: WebsiteIngestionService,
  ) {}

  private async get(tenantId: string, id: string) {
    const d = await this.prisma.knowledgeDocument.findFirst({
      where: { id, tenantId },
    });
    if (!d) throw new NotFoundException('Document not found');
    return d;
  }

  async detail(tenantId: string, id: string) {
    const d = await this.prisma.knowledgeDocument.findFirst({
      where: { id, tenantId },
      include: {
        source: {
          select: {
            id: true,
            sourceType: true,
            authorityLevel: true,
            canonicalUrl: true,
          },
        },
        _count: { select: { chunks: true } },
      },
    });
    if (!d) throw new NotFoundException('Document not found');
    return d;
  }

  async create(p: {
    tenantId: string;
    locationId?: string | null;
    title: string;
    content: string;
    visibility: KnowledgeVisibility;
    effectiveAt?: Date | null;
    expiresAt?: Date | null;
    canonicalUrl?: string | null;
    actorId: string;
  }) {
    const doc = await this.ingestion.createDocumentWithChunks({
      tenantId: p.tenantId,
      locationId: p.locationId,
      title: p.title,
      content: p.content,
      canonicalUrl: p.canonicalUrl,
      visibility: p.visibility,
      status: KnowledgeStatus.DRAFT,
      metadata: { createdBy: p.actorId, ingestedFrom: 'staff' },
    });
    if (p.effectiveAt || p.expiresAt) {
      return this.prisma.knowledgeDocument.update({
        where: { id: doc.id },
        data: {
          effectiveAt: p.effectiveAt ?? null,
          expiresAt: p.expiresAt ?? null,
        },
      });
    }
    return doc;
  }

  async edit(p: {
    tenantId: string;
    id: string;
    title?: string;
    content?: string;
    visibility?: KnowledgeVisibility;
    locationId?: string | null;
    effectiveAt?: Date | null;
    expiresAt?: Date | null;
    actorId: string;
  }) {
    const d = await this.get(p.tenantId, p.id);
    if (d.status === 'ARCHIVED')
      throw new ConflictException('Archived documents are read-only');
    if (p.effectiveAt && p.expiresAt && p.expiresAt <= p.effectiveAt)
      throw new BadRequestException('expiresAt must be after effectiveAt');
    const contentChanged = p.content !== undefined && p.content !== d.content;
    const data: Prisma.KnowledgeDocumentUpdateInput = {
      ...(p.title !== undefined ? { title: p.title } : {}),
      ...(p.visibility ? { visibility: p.visibility } : {}),
      ...(p.locationId !== undefined
        ? {
            location: p.locationId
              ? { connect: { id: p.locationId } }
              : { disconnect: true },
          }
        : {}),
      ...(p.effectiveAt !== undefined ? { effectiveAt: p.effectiveAt } : {}),
      ...(p.expiresAt !== undefined ? { expiresAt: p.expiresAt } : {}),
    };
    // Any content/visibility change to customer-facing material requires re-review.
    const needsReview =
      contentChanged || (p.visibility && p.visibility !== d.visibility);
    if (needsReview && (d.status === 'PUBLISHED' || d.status === 'APPROVED')) {
      data.status = KnowledgeStatus.DRAFT;
      data.approvedAt = null;
      data.approvedByUserId = null;
    }
    return this.prisma.$transaction(async (tx) => {
      if (contentChanged) {
        const chunks = this.chunker.splitText(p.content!, {
          documentTitle: p.title ?? d.title,
          canonicalUrl: d.canonicalUrl,
        });
        await tx.knowledgeChunk.deleteMany({ where: { documentId: d.id } });
        if (chunks.length) {
          await tx.knowledgeChunk.createMany({
            data: chunks.map((c) => ({
              tenantId: d.tenantId,
              documentId: d.id,
              locationId:
                p.locationId !== undefined ? p.locationId : d.locationId,
              chunkIndex: c.chunkIndex,
              content: c.content,
              tokenCount: c.tokenCount,
              metadata: c.metadata as Prisma.InputJsonValue,
            })),
          });
        }
        data.content = p.content;
        data.contentChecksum = this.ingestion.checksum(p.content!);
        data.version = { increment: 1 };
      } else if (p.locationId !== undefined) {
        await tx.knowledgeChunk.updateMany({
          where: { documentId: d.id },
          data: { locationId: p.locationId },
        });
      }
      const updated = await tx.knowledgeDocument.update({
        where: { id: d.id },
        data,
      });
      await tx.auditLog.create({
        data: {
          tenantId: p.tenantId,
          userId: p.actorId,
          action: 'knowledge.edit',
          resource: 'KnowledgeDocument',
          resourceId: d.id,
          metadata: { contentChanged, needsReview: !!needsReview },
        },
      });
      return updated;
    });
  }

  async transition(p: {
    tenantId: string;
    id: string;
    to: KnowledgeStatus;
    actorId: string;
    actorRole: string;
    note?: string;
  }) {
    const d = await this.get(p.tenantId, p.id);
    if (!FLOW[d.status].includes(p.to))
      throw new ConflictException(`Cannot move ${d.status} → ${p.to}`);
    if (
      (p.to === 'APPROVED' || p.to === 'PUBLISHED') &&
      !['SUPER_ADMIN', 'ADMIN', 'MANAGER'].includes(p.actorRole)
    ) {
      throw new ConflictException(
        'Approval and publishing require a manager or admin',
      );
    }
    if (p.to === 'PUBLISHED' && d.status !== 'APPROVED')
      throw new ConflictException('Only approved documents can be published');
    const now = new Date();
    const updated = await this.prisma.knowledgeDocument.update({
      where: { id: d.id },
      data: {
        status: p.to,
        ...(p.to === 'APPROVED'
          ? {
              approvedAt: now,
              approvedByUserId: p.actorId,
              lastVerifiedAt: now,
            }
          : {}),
        ...(p.to === 'ARCHIVED' ? { archivedAt: now } : {}),
      },
    });
    await this.prisma.auditLog.create({
      data: {
        tenantId: p.tenantId,
        userId: p.actorId,
        action: `knowledge.${p.to.toLowerCase()}`,
        resource: 'KnowledgeDocument',
        resourceId: d.id,
        metadata: { from: d.status, note: p.note ?? null },
      },
    });
    return updated;
  }

  async markVerified(tenantId: string, id: string, actorId: string) {
    await this.get(tenantId, id);
    return this.prisma.knowledgeDocument.update({
      where: { id },
      data: { lastVerifiedAt: new Date(), metadata: { verifiedBy: actorId } },
    });
  }

  /** Exactly what the CUSTOMER assistant could retrieve for a query (published + customer + in window). */
  preview(
    tenantId: string,
    locationId: string | null | undefined,
    query: string,
  ) {
    return this.retrieval.search({
      tenantId,
      locationId,
      query,
      forWidget: true,
      limit: 5,
    });
  }

  ingestWebsite(
    tenantId: string,
    locationId: string | null | undefined,
    url: string,
    title?: string,
  ) {
    return this.website.ingestUrl({ tenantId, locationId, url, title });
  }

  list(
    tenantId: string,
    opts: {
      locationId?: string | null;
      status?: KnowledgeStatus;
      visibility?: KnowledgeVisibility;
    },
  ) {
    return this.prisma.knowledgeDocument.findMany({
      where: {
        tenantId,
        ...(opts.locationId
          ? { OR: [{ locationId: opts.locationId }, { locationId: null }] }
          : {}),
        ...(opts.status ? { status: opts.status } : { archivedAt: null }),
        ...(opts.visibility ? { visibility: opts.visibility } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: 200,
      select: {
        id: true,
        title: true,
        status: true,
        visibility: true,
        version: true,
        locationId: true,
        effectiveAt: true,
        expiresAt: true,
        approvedAt: true,
        lastVerifiedAt: true,
        canonicalUrl: true,
        updatedAt: true,
        source: { select: { sourceType: true, authorityLevel: true } },
      },
    });
  }
}
