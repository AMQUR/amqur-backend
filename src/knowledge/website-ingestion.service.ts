import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { safeFetchText } from '../common/security/safe-fetch';
import { assertFeedUrlAllowed } from '../common/security/feed-url.guard';
import { KnowledgeIngestionService } from './knowledge-ingestion.service';
import {
  KnowledgeAuthorityLevel,
  KnowledgeSourceType,
  KnowledgeStatus,
  KnowledgeVisibility,
} from '@prisma/client';

const MAX_HTML_BYTES = 2_000_000;

/**
 * Controlled website ingestion — allowlisted hosts only, SSRF-guarded.
 * Fetched content becomes DRAFT knowledge pending approval (fail-closed authority).
 */
@Injectable()
export class WebsiteIngestionService {
  private readonly logger = new Logger(WebsiteIngestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ingestion: KnowledgeIngestionService,
  ) {}

  async ingestUrl(params: {
    tenantId: string;
    locationId?: string | null;
    url: string;
    title?: string;
  }) {
    const parsed = assertFeedUrlAllowed(params.url);
    const host = parsed.hostname.toLowerCase();

    const allowed = await this.prisma.websiteAllowedDomain.findFirst({
      where: {
        tenantId: params.tenantId,
        hostname: host,
        enabled: true,
      },
    });
    if (!allowed) {
      throw new BadRequestException(
        `Host "${host}" is not an allowlisted website source for this tenant`,
      );
    }
    if (allowed.pathPrefix && !parsed.pathname.startsWith(allowed.pathPrefix)) {
      throw new BadRequestException('URL path is outside allowlisted prefix');
    }

    const validate = (u: URL) => {
      assertFeedUrlAllowed(u.toString());
      if (u.hostname.toLowerCase() !== host) {
        throw new BadRequestException('Redirect left the allowlisted host');
      }
      if (allowed.pathPrefix && !u.pathname.startsWith(allowed.pathPrefix)) {
        throw new BadRequestException('URL path is outside allowlisted prefix');
      }
    };
    const fetched = await safeFetchText(parsed.toString(), {
      validate,
      maxBytes: MAX_HTML_BYTES,
      timeoutMs: 15_000,
      userAgent: 'AMQUR-KnowledgeBot/1.0 (+dealership-kb)',
    });
    const html = fetched.text;

    const text = this.sanitizeHtmlToText(html);
    if (text.trim().length < 40) {
      throw new BadRequestException('Page produced insufficient text content');
    }

    const checksum = createHash('sha256').update(text).digest('hex');
    this.logger.log(
      `Ingested website page tenant=${params.tenantId} host=${host} checksum=${checksum.slice(0, 12)}`,
    );

    const source = await this.prisma.knowledgeSource.create({
      data: {
        tenantId: params.tenantId,
        locationId: params.locationId ?? null,
        sourceType: KnowledgeSourceType.VERIFIED_WEBSITE,
        title: params.title ?? parsed.hostname + parsed.pathname,
        canonicalUrl: parsed.toString(),
        authorityLevel: KnowledgeAuthorityLevel.UNVERIFIED,
        status: KnowledgeStatus.PENDING_REVIEW,
        metadata: { checksum, requiresApproval: allowed.requiresApproval },
      },
    });

    return this.ingestion.createDocumentWithChunks({
      tenantId: params.tenantId,
      locationId: params.locationId ?? null,
      sourceId: source.id,
      title: source.title,
      canonicalUrl: parsed.toString(),
      content: text,
      visibility: KnowledgeVisibility.CUSTOMER,
      status: KnowledgeStatus.DRAFT,
      metadata: {
        ingestedFrom: 'website',
        host,
        note: 'DATA only — requires human approval before customer authority',
      },
    });
  }

  /** Strip scripts/styles and collapse whitespace — not a full HTML sanitizer for XSS (staff-only ingest). */
  sanitizeHtmlToText(html: string): string {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
