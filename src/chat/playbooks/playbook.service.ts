import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  PlaybookDepartment,
  PlaybookStatus,
  Prisma,
} from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';

export type PlaybookInput = {
  key: string;
  title: string;
  department?: PlaybookDepartment;
  tone?: string;
  brevity?: string;
  allowRapport?: boolean;
  oneQuestion?: boolean;
  approvedPhrases?: string[];
  forbiddenPhrases?: string[];
  examples?: Array<{ good: string; bad: string; note?: string }>;
  coachingNotes?: string | null;
};

/** Style hints safe to inject into compose — never facts, never safety overrides. */
export type PublishedStyleHints = {
  playbookId: string;
  key: string;
  version: number;
  tone: string;
  brevity: string;
  oneQuestion: boolean;
  allowRapport: boolean;
  approvedPhrases: string[];
  forbiddenPhrases: string[];
  department: PlaybookDepartment;
};

const TONES = new Set([
  'casual',
  'professional',
  'concise',
  'friendly',
  'premium',
]);
const BREVITY = new Set(['short', 'standard', 'detailed']);

@Injectable()
export class PlaybookService {
  constructor(private readonly prisma: PrismaService) {}

  private scope(locationId?: string | null) {
    return locationId ?? '_';
  }

  async list(tenantId: string, locationId?: string | null) {
    return this.prisma.conversationPlaybook.findMany({
      where: {
        tenantId,
        OR: [
          { locationScope: '_' },
          ...(locationId
            ? [{ locationScope: locationId, locationId }]
            : []),
        ],
      },
      orderBy: [{ key: 'asc' }, { version: 'desc' }],
      take: 200,
    });
  }

  async get(tenantId: string, id: string) {
    const row = await this.prisma.conversationPlaybook.findFirst({
      where: { id, tenantId },
    });
    if (!row) throw new NotFoundException('Playbook not found');
    return row;
  }

  async create(
    tenantId: string,
    userId: string,
    locationId: string | null | undefined,
    input: PlaybookInput,
  ) {
    this.validate(input);
    const locationScope = this.scope(locationId);
    const latest = await this.prisma.conversationPlaybook.findFirst({
      where: { tenantId, locationScope, key: input.key },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    return this.prisma.conversationPlaybook.create({
      data: {
        tenantId,
        locationId: locationId ?? null,
        locationScope,
        key: input.key.slice(0, 80),
        title: input.title.slice(0, 160),
        department: input.department ?? PlaybookDepartment.GENERAL,
        status: PlaybookStatus.DRAFT,
        version: (latest?.version ?? 0) + 1,
        tone: input.tone ?? 'concise',
        brevity: input.brevity ?? 'short',
        allowRapport: input.allowRapport === true,
        oneQuestion: input.oneQuestion !== false,
        approvedPhrases: (input.approvedPhrases ?? []) as Prisma.InputJsonValue,
        forbiddenPhrases: (input.forbiddenPhrases ??
          []) as Prisma.InputJsonValue,
        examples: (input.examples ?? []) as Prisma.InputJsonValue,
        coachingNotes: input.coachingNotes?.slice(0, 4000) ?? null,
        createdBy: userId,
      },
    });
  }

  async updateDraft(
    tenantId: string,
    userId: string,
    id: string,
    patch: Partial<PlaybookInput>,
  ) {
    const row = await this.get(tenantId, id);
    if (row.status !== PlaybookStatus.DRAFT && row.status !== PlaybookStatus.REJECTED)
      throw new BadRequestException('Only drafts can be edited');
    if (patch.key || patch.title || patch.tone || patch.brevity)
      this.validate({
        key: patch.key ?? row.key,
        title: patch.title ?? row.title,
        tone: patch.tone ?? row.tone,
        brevity: patch.brevity ?? row.brevity,
      });
    return this.prisma.conversationPlaybook.update({
      where: { id: row.id },
      data: {
        ...(patch.title ? { title: patch.title.slice(0, 160) } : {}),
        ...(patch.department ? { department: patch.department } : {}),
        ...(patch.tone ? { tone: patch.tone } : {}),
        ...(patch.brevity ? { brevity: patch.brevity } : {}),
        ...(typeof patch.allowRapport === 'boolean'
          ? { allowRapport: patch.allowRapport }
          : {}),
        ...(typeof patch.oneQuestion === 'boolean'
          ? { oneQuestion: patch.oneQuestion }
          : {}),
        ...(patch.approvedPhrases
          ? {
              approvedPhrases: patch.approvedPhrases as Prisma.InputJsonValue,
            }
          : {}),
        ...(patch.forbiddenPhrases
          ? {
              forbiddenPhrases: patch.forbiddenPhrases as Prisma.InputJsonValue,
            }
          : {}),
        ...(patch.examples
          ? { examples: patch.examples as Prisma.InputJsonValue }
          : {}),
        ...(patch.coachingNotes !== undefined
          ? { coachingNotes: patch.coachingNotes?.slice(0, 4000) ?? null }
          : {}),
        status: PlaybookStatus.DRAFT,
        updatedAt: new Date(),
      },
    });
  }

  async submitForReview(tenantId: string, userId: string, id: string) {
    const row = await this.get(tenantId, id);
    if (row.status !== PlaybookStatus.DRAFT && row.status !== PlaybookStatus.REJECTED)
      throw new BadRequestException('Only drafts can be submitted');
    const updated = await this.prisma.conversationPlaybook.update({
      where: { id },
      data: { status: PlaybookStatus.PENDING_REVIEW },
    });
    await this.audit(tenantId, userId, 'playbook.submit_review', id, {
      key: row.key,
      version: row.version,
    });
    return updated;
  }

  async approve(tenantId: string, userId: string, id: string) {
    const row = await this.get(tenantId, id);
    if (row.status !== PlaybookStatus.PENDING_REVIEW)
      throw new BadRequestException('Playbook is not pending review');
    if (row.createdBy && row.createdBy === userId)
      throw new ForbiddenException(
        'A different manager must approve this playbook',
      );
    const updated = await this.prisma.conversationPlaybook.update({
      where: { id },
      data: {
        status: PlaybookStatus.APPROVED,
        approvedAt: new Date(),
        approvedBy: userId,
      },
    });
    await this.audit(tenantId, userId, 'playbook.approve', id, {
      key: row.key,
      version: row.version,
    });
    return updated;
  }

  /**
   * Publish an APPROVED playbook. Archives any previously PUBLISHED version
   * for the same key+scope. Never auto-publishes from draft.
   */
  async publish(tenantId: string, userId: string, id: string) {
    const row = await this.get(tenantId, id);
    if (
      row.status !== PlaybookStatus.APPROVED &&
      row.status !== PlaybookStatus.PUBLISHED
    )
      throw new BadRequestException(
        'Playbook must be approved before publish',
      );

    return this.prisma.$transaction(async (tx) => {
      const previous = await tx.conversationPlaybook.findMany({
        where: {
          tenantId,
          locationScope: row.locationScope,
          key: row.key,
          status: PlaybookStatus.PUBLISHED,
          id: { not: row.id },
        },
      });
      for (const p of previous) {
        await tx.conversationPlaybook.update({
          where: { id: p.id },
          data: { status: PlaybookStatus.ARCHIVED },
        });
      }
      const published = await tx.conversationPlaybook.update({
        where: { id: row.id },
        data: {
          status: PlaybookStatus.PUBLISHED,
          publishedAt: new Date(),
          publishedBy: userId,
          supersedesId: previous[0]?.id ?? row.supersedesId,
        },
      });
      const snapshot = JSON.stringify({
        key: published.key,
        version: published.version,
        tone: published.tone,
        brevity: published.brevity,
        phrases: published.approvedPhrases,
        forbidden: published.forbiddenPhrases,
      });
      const checksum = createHash('sha256').update(snapshot).digest('hex').slice(0, 32);
      await tx.promptVersion.create({
        data: {
          tenantId,
          locationId: published.locationId,
          locationScope: published.locationScope,
          kind: 'playbook_snapshot',
          version: `${published.key}-v${published.version}`,
          status: PlaybookStatus.PUBLISHED,
          content: snapshot,
          checksum,
          publishedAt: new Date(),
          publishedBy: userId,
          createdBy: userId,
          notes: `Published playbook ${published.key} v${published.version}`,
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          userId,
          action: 'playbook.publish',
          resource: 'ConversationPlaybook',
          resourceId: published.id,
          metadata: {
            key: published.key,
            version: published.version,
            archived: previous.map((p) => p.id),
          } as Prisma.InputJsonValue,
        },
      });
      await tx.tenant.update({
        where: { id: tenantId },
        data: { configVersion: { increment: 1 } },
      });
      return published;
    });
  }

  /** Roll back to a prior archived/published version by re-publishing it. */
  async rollback(
    tenantId: string,
    userId: string,
    targetId: string,
  ) {
    const target = await this.get(tenantId, targetId);
    if (
      target.status !== PlaybookStatus.ARCHIVED &&
      target.status !== PlaybookStatus.PUBLISHED &&
      target.status !== PlaybookStatus.APPROVED
    )
      throw new BadRequestException('Cannot roll back to this version');
    // Clone as a new APPROVED version then publish — preserves history.
    const clone = await this.prisma.conversationPlaybook.create({
      data: {
        tenantId,
        locationId: target.locationId,
        locationScope: target.locationScope,
        key: target.key,
        title: `${target.title} (rollback of v${target.version})`,
        department: target.department,
        status: PlaybookStatus.APPROVED,
        version:
          ((
            await this.prisma.conversationPlaybook.findFirst({
              where: {
                tenantId,
                locationScope: target.locationScope,
                key: target.key,
              },
              orderBy: { version: 'desc' },
              select: { version: true },
            })
          )?.version ?? target.version) + 1,
        tone: target.tone,
        brevity: target.brevity,
        allowRapport: target.allowRapport,
        oneQuestion: target.oneQuestion,
        approvedPhrases: target.approvedPhrases as Prisma.InputJsonValue,
        forbiddenPhrases: target.forbiddenPhrases as Prisma.InputJsonValue,
        examples: target.examples as Prisma.InputJsonValue,
        coachingNotes: target.coachingNotes,
        supersedesId: target.id,
        approvedAt: new Date(),
        approvedBy: userId,
        createdBy: userId,
      },
    });
    return this.publish(tenantId, userId, clone.id);
  }

  /** Active published style for compose — location overrides tenant-wide. */
  async publishedHints(
    tenantId: string,
    locationId: string | null | undefined,
    department?: PlaybookDepartment | null,
  ): Promise<PublishedStyleHints | null> {
    const dept = department ?? PlaybookDepartment.GENERAL;
    const tryFind = async (scope: string, dep: PlaybookDepartment) =>
      this.prisma.conversationPlaybook.findFirst({
        where: {
          tenantId,
          locationScope: scope,
          status: PlaybookStatus.PUBLISHED,
          department: dep,
        },
        orderBy: { publishedAt: 'desc' },
      });
    const locScope = locationId ? locationId : null;
    let row =
      (locScope ? await tryFind(locScope, dept) : null) ??
      (await tryFind('_', dept)) ??
      (locScope ? await tryFind(locScope, PlaybookDepartment.GENERAL) : null) ??
      (await tryFind('_', PlaybookDepartment.GENERAL));
    if (!row) return null;
    return {
      playbookId: row.id,
      key: row.key,
      version: row.version,
      tone: row.tone,
      brevity: row.brevity,
      oneQuestion: row.oneQuestion,
      allowRapport: row.allowRapport,
      approvedPhrases: asStringArray(row.approvedPhrases),
      forbiddenPhrases: asStringArray(row.forbiddenPhrases),
      department: row.department,
    };
  }

  /**
   * Safe preview: apply style gates to a candidate reply against a playbook
   * (draft or published). Does not call the LLM or touch production traffic.
   */
  previewStyle(
    playbook: {
      oneQuestion?: boolean;
      forbiddenPhrases?: unknown;
      brevity?: string;
    },
    candidate: string,
  ) {
    const reasons: string[] = [];
    const q = (candidate.match(/\?/g) ?? []).length;
    if (playbook.oneQuestion !== false && q > 1)
      reasons.push('multiple_questions');
    for (const phrase of asStringArray(playbook.forbiddenPhrases)) {
      if (phrase && candidate.toLowerCase().includes(phrase.toLowerCase()))
        reasons.push(`forbidden_phrase:${phrase.slice(0, 40)}`);
    }
    if (
      (playbook.brevity ?? 'short') === 'short' &&
      candidate.length > 480
    )
      reasons.push('too_long_for_short_brevity');
    return {
      ok: reasons.length === 0,
      reasons,
      sentences: candidate.split(/(?<=[.!?])\s+/).filter(Boolean).length,
      questions: q,
      chars: candidate.length,
    };
  }

  private validate(input: {
    key: string;
    title: string;
    tone?: string;
    brevity?: string;
  }) {
    if (!/^[a-z0-9][a-z0-9_-]{1,78}$/.test(input.key))
      throw new BadRequestException(
        'key must be lowercase alphanumeric with -/_',
      );
    if (!input.title?.trim())
      throw new BadRequestException('title required');
    if (input.tone && !TONES.has(input.tone))
      throw new BadRequestException('invalid tone');
    if (input.brevity && !BREVITY.has(input.brevity))
      throw new BadRequestException('invalid brevity');
  }

  private async audit(
    tenantId: string,
    userId: string,
    action: string,
    id: string,
    metadata: Record<string, unknown>,
  ) {
    await this.prisma.auditLog.create({
      data: {
        tenantId,
        userId,
        action,
        resource: 'ConversationPlaybook',
        resourceId: id,
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
  }
}

function asStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === 'string').slice(0, 50);
}
