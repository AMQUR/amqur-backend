import { decodeCanonicalBase64Url } from '../common/security/webhook-signature';
import { createHash, randomBytes } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import * as path from 'path';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { readFile } from 'fs/promises';
import { createHmac, timingSafeEqual } from 'crypto';
import { EXT_FOR, sniffMime } from './file-sniff';
import { FilePurpose, FileScanStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);

const MAX_BYTES = 10 * 1024 * 1024;

export interface MalwareScanner {
  scan(_: { storageKey: string; mimeType: string }): Promise<FileScanStatus>;
}

export class SkippedMalwareScanner implements MalwareScanner {
  async scan(): Promise<FileScanStatus> {
    return FileScanStatus.SKIPPED;
  }
}

@Injectable()
export class UploadsService {
  private readonly uploadRoot: string;

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    private readonly scanner: MalwareScanner = new SkippedMalwareScanner(),
  ) {
    this.uploadRoot = path.join(process.cwd(), 'uploads');
  }

  validateMime(mimeType: string): void {
    if (!ALLOWED_MIME.has(mimeType)) {
      throw new BadRequestException(`MIME type not allowed: ${mimeType}`);
    }
  }

  validateSize(byteSize: number): void {
    if (byteSize <= 0 || byteSize > MAX_BYTES) {
      throw new BadRequestException(
        `File size must be between 1 byte and ${MAX_BYTES} bytes`,
      );
    }
  }

  /**
   * Durable storage is required in production. The bundled local-disk store is ephemeral on
   * container platforms, so production uploads fail closed until an object store adapter is
   * configured (UPLOAD_STORAGE=s3 + bucket credentials — see PRODUCTION_BLOCKERS).
   */
  assertStorageReady(): void {
    const mode = process.env.UPLOAD_STORAGE ?? 'local';
    if (process.env.NODE_ENV === 'production' && mode === 'local') {
      throw new ForbiddenException('uploads_storage_not_configured');
    }
  }

  /**
   * Production requires CLEAN. Local/demo may attach SKIPPED when no malware
   * scanner is configured (SkippedMalwareScanner) — never in production.
   */
  isAttachableScanStatus(status: FileScanStatus): boolean {
    if (status === FileScanStatus.CLEAN) return true;
    if (
      status === FileScanStatus.SKIPPED &&
      process.env.NODE_ENV !== 'production'
    ) {
      return true;
    }
    return false;
  }

  private safeStorageKey(tenantId: string, mime: string): string {
    // Extension derives from the verified content type, never the client filename.
    const ext = EXT_FOR[mime] ?? '';
    const token = randomBytes(16).toString('hex');
    const key = `${tenantId}/${token}${ext}`;
    const resolved = path.resolve(this.uploadRoot, key);
    if (!resolved.startsWith(path.resolve(this.uploadRoot))) {
      throw new BadRequestException('Invalid storage path');
    }
    return key;
  }

  async upload(params: {
    tenantId: string;
    locationId?: string | null;
    buffer: Buffer;
    originalName: string;
    mimeType: string;
    purpose: FilePurpose;
    uploadedByUserId?: string | null;
    conversationId?: string | null;
  }) {
    this.assertStorageReady();
    this.validateMime(params.mimeType);
    this.validateSize(params.buffer.length);
    const sniffed = sniffMime(params.buffer);
    if (!sniffed || sniffed !== params.mimeType) {
      throw new BadRequestException(
        'File content does not match an allowed type',
      );
    }
    const quota = Number(
      process.env.UPLOAD_TENANT_QUOTA_BYTES ?? 2_000_000_000,
    );
    const used = await this.prisma.fileObject.aggregate({
      where: { tenantId: params.tenantId, deletedAt: null },
      _sum: { byteSize: true },
    });
    if ((used._sum.byteSize ?? 0) + params.buffer.length > quota) {
      throw new ForbiddenException('Tenant upload quota exceeded');
    }

    const storageKey = this.safeStorageKey(params.tenantId, sniffed);
    const checksumSha256 = createHash('sha256')
      .update(params.buffer)
      .digest('hex');

    const dir = path.dirname(path.join(this.uploadRoot, storageKey));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(this.uploadRoot, storageKey), params.buffer);

    const scannedStatus = await this.scanner.scan({
      storageKey,
      mimeType: params.mimeType,
    });

    return this.prisma.fileObject.create({
      data: {
        tenantId: params.tenantId,
        locationId: params.locationId ?? null,
        storageKey,
        originalName: path
          .basename(params.originalName)
          .replace(/[^\w.\- ]/g, '_')
          .slice(0, 120),
        mimeType: params.mimeType,
        byteSize: params.buffer.length,
        checksumSha256,
        purpose: params.purpose,
        scannedStatus,
        uploadedByUserId: params.uploadedByUserId ?? null,
        conversationId: params.conversationId ?? null,
      },
    });
  }

  private signKey(): Buffer {
    return createHmac('sha256', process.env.JWT_SECRET ?? '')
      .update('amqur.file-url.v1')
      .digest();
  }

  /** Short-lived signed staff download path (no bearer token in the URL). */
  signedPath(tenantId: string, fileId: string, ttlSeconds = 300): string {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const sig = createHmac('sha256', this.signKey())
      .update(`${tenantId}:${fileId}:${exp}`)
      .digest('base64url');
    return `/uploads/${fileId}/download?t=${encodeURIComponent(tenantId)}&e=${exp}&s=${sig}`;
  }

  /**
   * Files are served only as attachments with nosniff. Unscanned (SKIPPED/PENDING/ERROR) or
   * REJECTED files are QUARANTINED: never served to customers and never rendered inline.
   */
  async readForDownload(
    fileId: string,
    q: { t: string; e: string; s: string },
  ) {
    const exp = Number(q.e);
    if (!exp || exp < Math.floor(Date.now() / 1000))
      throw new ForbiddenException('Link expired');
    const want = createHmac('sha256', this.signKey())
      .update(`${q.t}:${fileId}:${exp}`)
      .digest();
    const got = decodeCanonicalBase64Url(q.s ?? '');
    if (!got) throw new ForbiddenException('Bad signature');
    if (got.length !== want.length || !timingSafeEqual(got, want))
      throw new ForbiddenException('Bad signature');
    const f = await this.prisma.fileObject.findFirst({
      where: { id: fileId, tenantId: q.t, deletedAt: null },
    });
    if (!f) throw new NotFoundException();
    if (f.scannedStatus === 'REJECTED')
      throw new ForbiddenException('File quarantined');
    const buf = await readFile(path.join(this.uploadRoot, f.storageKey));
    return { file: f, buf, quarantined: f.scannedStatus !== 'CLEAN' };
  }

  /** Staff-facing attachment row (no storage keys). */
  staffAttachmentView(
    tenantId: string,
    f: {
      id: string;
      originalName: string;
      mimeType: string;
      byteSize: number;
      purpose: FilePurpose;
      scannedStatus: FileScanStatus;
      conversationId: string | null;
      createdAt: Date;
    },
  ) {
    return {
      id: f.id,
      originalName: f.originalName,
      mimeType: f.mimeType,
      byteSize: f.byteSize,
      purpose: f.purpose,
      scannedStatus: f.scannedStatus,
      conversationId: f.conversationId,
      createdAt: f.createdAt,
      downloadPath:
        f.scannedStatus === FileScanStatus.CLEAN
          ? this.signedPath(tenantId, f.id)
          : null,
    };
  }

  /**
   * Link an existing tenant file to a conversation. Only CLEAN files may be attached;
   * quarantined / pending scans stay unlinkable (fail closed).
   */
  async attachToConversation(params: {
    tenantId: string;
    conversationId: string;
    fileId: string;
  }) {
    const conv = await this.prisma.conversation.findFirst({
      where: { id: params.conversationId, tenantId: params.tenantId },
      select: { id: true, locationId: true },
    });
    if (!conv) throw new NotFoundException('Conversation not found');

    const file = await this.prisma.fileObject.findFirst({
      where: {
        id: params.fileId,
        tenantId: params.tenantId,
        deletedAt: null,
      },
    });
    if (!file) throw new NotFoundException('File not found');

    if (!this.isAttachableScanStatus(file.scannedStatus)) {
      throw new ForbiddenException('file_not_clean');
    }
    if (file.conversationId && file.conversationId !== params.conversationId) {
      throw new ConflictException(
        'File already linked to another conversation',
      );
    }
    if (file.conversationId === params.conversationId) {
      return this.staffAttachmentView(params.tenantId, file);
    }

    const updated = await this.prisma.fileObject.update({
      where: { id: file.id },
      data: {
        conversationId: params.conversationId,
        locationId: file.locationId ?? conv.locationId ?? null,
      },
    });
    return this.staffAttachmentView(params.tenantId, updated);
  }

  async listConversationAttachments(tenantId: string, conversationId: string) {
    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, tenantId },
      select: { id: true },
    });
    if (!conv) throw new NotFoundException('Conversation not found');

    const files = await this.prisma.fileObject.findMany({
      where: { tenantId, conversationId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        originalName: true,
        mimeType: true,
        byteSize: true,
        purpose: true,
        scannedStatus: true,
        conversationId: true,
        createdAt: true,
      },
    });
    return {
      attachments: files.map((f) => this.staffAttachmentView(tenantId, f)),
    };
  }
}
