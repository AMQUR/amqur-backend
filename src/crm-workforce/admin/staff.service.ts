import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor } from '../control.service';

const INVITE_TTL_MS = 72 * 3_600_000;
const RESET_TTL_MS = 24 * 3_600_000;
const ROLE_RANK: Record<string, number> = {
  STAFF: 0,
  MANAGER: 1,
  ADMIN: 2,
  SUPER_ADMIN: 3,
};
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** A password nobody knows: the account cannot be signed into until the link is used. */
const unusable = () => bcrypt.hash(randomBytes(32).toString('hex'), 10);

export type StaffRole = 'STAFF' | 'MANAGER' | 'ADMIN';

/**
 * Staff accounts for one dealership, run from the Command Center.
 *
 *  - Administrators invite people; the person sets their own password from a one-time link.
 *    Nobody else ever chooses or sees a password.
 *  - A reset signs the person out everywhere and issues a fresh one-time link.
 *  - Nobody can grant a role above their own, change their own role, or switch themselves off.
 *    Granting ADMIN needs a written reason and is audited.
 *  - Someone acting in another dealership through a group membership manages only roles below
 *    ADMIN there: they cannot invite, reset, switch off or change an administrator, because a
 *    reset link would hand them that administrator's full account.
 *  - Links are shown once to the administrator, who passes them on. No email is sent: the
 *    platform has no approved staff-email channel.
 */
@Injectable()
export class CrmWfStaffService {
  constructor(private readonly prisma: PrismaService) {}

  private admin(actor: Actor) {
    if (!['ADMIN', 'SUPER_ADMIN'].includes(actor.role))
      throw new ForbiddenException('staff_management_requires_admin');
  }

  async list(actor: Actor, tenantId: string) {
    if (!['ADMIN', 'SUPER_ADMIN', 'MANAGER'].includes(actor.role))
      throw new ForbiddenException('staff_list_requires_manager');
    const [users, locations, tokens] = await Promise.all([
      this.prisma.user.findMany({
        where: { tenantId },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
          isActive: true,
          mfaEnabled: true,
          locationId: true,
          createdAt: true,
        },
        orderBy: [{ isActive: 'desc' }, { firstName: 'asc' }],
      }),
      this.prisma.location.findMany({
        where: { tenantId },
        select: { id: true, name: true },
      }),
      this.prisma.crmWfStaffToken.findMany({
        where: {
          tenantId,
          usedAt: null,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        select: { userId: true, purpose: true, expiresAt: true },
      }),
    ]);
    return users.map((u) => ({
      ...u,
      location: locations.find((l) => l.id === u.locationId)?.name ?? null,
      pending: tokens.find((t) => t.userId === u.id) ?? null,
    }));
  }

  private async issue(
    tenantId: string,
    userId: string,
    purpose: 'INVITE' | 'RESET',
    actor: Actor,
  ) {
    const token = randomBytes(32).toString('base64url');
    await this.prisma.crmWfStaffToken.updateMany({
      where: { tenantId, userId, usedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const row = await this.prisma.crmWfStaffToken.create({
      data: {
        tenantId,
        userId,
        purpose,
        tokenHash: sha(token),
        expiresAt: new Date(
          Date.now() + (purpose === 'INVITE' ? INVITE_TTL_MS : RESET_TTL_MS),
        ),
        createdByUserId: actor.userId,
      },
    });
    // The token itself is returned once and never stored.
    return {
      link: `/cc/#/set-password?token=${token}`,
      expiresAt: row.expiresAt,
    };
  }

  private checkGrant(actor: Actor, role: StaffRole, reason?: string) {
    if (ROLE_RANK[role] > ROLE_RANK[actor.role])
      throw new ForbiddenException('cannot_grant_a_role_above_your_own');
    if (actor.groupActing && ROLE_RANK[role] >= ROLE_RANK.ADMIN)
      throw new ForbiddenException(
        'administrators_are_managed_by_their_own_dealership',
      );
    if (role === 'ADMIN' && (reason ?? '').trim().length < 10)
      throw new BadRequestException(
        'granting_admin_needs_a_reason_of_10_or_more_characters',
      );
  }

  async invite(
    actor: Actor,
    tenantId: string,
    p: {
      email: string;
      firstName: string;
      lastName: string;
      role: StaffRole;
      locationId?: string | null;
      reason?: string;
    },
  ) {
    this.admin(actor);
    this.checkGrant(actor, p.role, p.reason);
    const email = p.email.trim().toLowerCase();
    if (p.role !== 'ADMIN') {
      if (!p.locationId)
        throw new BadRequestException('choose_the_rooftop_for_this_person');
    }
    if (p.locationId) {
      const loc = await this.prisma.location.findFirst({
        where: { id: p.locationId, tenantId },
        select: { id: true },
      });
      if (!loc) throw new ForbiddenException('Location access denied');
    }
    const exists = await this.prisma.user.findUnique({
      where: { tenantId_email: { tenantId, email } },
      select: { id: true },
    });
    if (exists)
      throw new ConflictException(
        'someone_with_this_email_already_has_an_account_here',
      );
    const user = await this.prisma.user.create({
      data: {
        tenantId,
        email,
        firstName: p.firstName.trim(),
        lastName: p.lastName.trim(),
        role: p.role as Role,
        locationId: p.role === 'ADMIN' ? null : p.locationId!,
        password: await unusable(),
        // Switched on when the person sets their password.
        isActive: false,
      },
      select: { id: true },
    });
    const link = await this.issue(tenantId, user.id, 'INVITE', actor);
    await this.audit(tenantId, actor, 'crmwf.staff.invited', user.id, {
      role: p.role,
      reason: p.reason ?? null,
    });
    return { userId: user.id, ...link };
  }

  private async target(actor: Actor, tenantId: string, userId: string) {
    this.admin(actor);
    if (userId === actor.userId)
      throw new ForbiddenException('you_cannot_change_your_own_account_here');
    const u = await this.prisma.user.findFirst({
      where: { id: userId, tenantId },
    });
    if (!u) throw new NotFoundException('staff_member_not_found');
    if (ROLE_RANK[u.role] > ROLE_RANK[actor.role])
      throw new ForbiddenException('cannot_manage_a_higher_role');
    if (actor.groupActing && ROLE_RANK[u.role] >= ROLE_RANK.ADMIN)
      throw new ForbiddenException(
        'administrators_are_managed_by_their_own_dealership',
      );
    return u;
  }

  /** Signs the person out everywhere and gives them a fresh link to set a new password. */
  async reset(actor: Actor, tenantId: string, userId: string) {
    const u = await this.target(actor, tenantId, userId);
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: u.id },
        data: { password: await unusable() },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId: u.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    const link = await this.issue(
      tenantId,
      u.id,
      u.isActive ? 'RESET' : 'INVITE',
      actor,
    );
    await this.audit(
      tenantId,
      actor,
      'crmwf.staff.password_reset_issued',
      u.id,
      {},
    );
    return link;
  }

  /**
   * Employee offboarding in one step: account off and every session ended, pending links
   * revoked, group memberships removed, their open staff items returned to the queue, their MFA
   * reset (so a returning account must re-enrol), and their staff-directory entries retired.
   * Audit history is kept. Not reversible by reactivation alone: memberships must be re-granted.
   */
  async offboard(
    actor: Actor,
    tenantId: string,
    userId: string,
    reason: string,
  ) {
    if ((reason ?? '').trim().length < 5)
      throw new BadRequestException('offboarding_needs_a_reason');
    const u = await this.target(actor, tenantId, userId);
    const now = new Date();
    const r = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: u.id },
        data: {
          isActive: false,
          mfaEnabled: false,
          mfaSecretEnc: Prisma.DbNull,
          mfaPendingSecretEnc: Prisma.DbNull,
          mfaRecoveryHashes: [],
          mfaLastCounter: null,
          mfaEnrolledAt: null,
        },
      });
      const sessions = await tx.refreshToken.updateMany({
        where: { userId: u.id, revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.crmWfStaffToken.updateMany({
        where: { userId: u.id, usedAt: null, revokedAt: null },
        data: { revokedAt: now },
      });
      const memberships = await tx.dealerGroupMembership.deleteMany({
        where: { userId: u.id },
      });
      const items = await tx.crmWfWorkItem.updateMany({
        where: {
          tenantId,
          assignedUserId: u.id,
          status: { in: ['OPEN', 'IN_PROGRESS'] },
        },
        data: { status: 'OPEN', assignedUserId: null, assigneeName: null },
      });
      const entries = await tx.dealerKnowledgeEntry.updateMany({
        where: {
          tenantId,
          status: { in: ['APPROVED', 'PROPOSED'] },
          kind: {
            in: ['STAFF_MEMBER', 'DEPARTMENT_MANAGER', 'ESCALATION_CONTACT'],
          },
          data: { path: ['email'], equals: u.email },
        },
        data: { status: 'RETIRED' },
      });
      return {
        sessionsEnded: sessions.count,
        groupMembershipsRemoved: memberships.count,
        workItemsReturned: items.count,
        directoryEntriesRetired: entries.count,
      };
    });
    await this.audit(tenantId, actor, 'crmwf.staff.offboarded', u.id, {
      reason: reason.trim().slice(0, 300),
      ...r,
    });
    return r;
  }

  /** Sign-ins, failed sign-ins, MFA events and staff changes for this dealership (no secrets). */
  async accessLog(actor: Actor, tenantId: string, days = 30) {
    if (!['ADMIN', 'SUPER_ADMIN'].includes(actor.role))
      throw new ForbiddenException('access_log_requires_admin');
    const since = new Date(
      Date.now() - Math.min(Math.max(days, 1), 90) * 86_400_000,
    );
    const rows = await this.prisma.auditLog.findMany({
      where: {
        tenantId,
        createdAt: { gte: since },
        OR: [
          { action: { startsWith: 'auth.' } },
          { action: { startsWith: 'crmwf.staff.' } },
          { action: { startsWith: 'crmwf.group_membership' } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 300,
      select: {
        id: true,
        action: true,
        createdAt: true,
        ip: true,
        metadata: true,
        resource: true,
        resourceId: true,
        user: { select: { firstName: true, lastName: true, email: true } },
      },
    });
    // Staff changes name both the person who acted and the person affected.
    const subjectIds = [
      ...new Set(
        rows
          .filter((r) => r.resource === 'User' && r.resourceId)
          .map((r) => r.resourceId!),
      ),
    ];
    const subjects = new Map(
      (
        await this.prisma.user.findMany({
          where: { id: { in: subjectIds }, tenantId },
          select: { id: true, firstName: true, lastName: true, email: true },
        })
      ).map((u) => [u.id, u]),
    );
    return rows.map((r) => {
      const subj =
        r.resource === 'User' && r.resourceId
          ? subjects.get(r.resourceId)
          : undefined;
      return {
        id: r.id,
        action: r.action,
        at: r.createdAt,
        who: r.user ? `${r.user.firstName} ${r.user.lastName}`.trim() : null,
        email: r.user?.email ?? null,
        subject: subj ? `${subj.firstName} ${subj.lastName}`.trim() : null,
        subjectEmail: subj?.email ?? null,
        ip: r.ip,
        reason: (r.metadata as { reason?: string } | null)?.reason ?? null,
      };
    });
  }

  async setActive(
    actor: Actor,
    tenantId: string,
    userId: string,
    active: boolean,
  ) {
    const u = await this.target(actor, tenantId, userId);
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: u.id },
        data: { isActive: active },
      }),
      ...(active
        ? []
        : [
            this.prisma.refreshToken.updateMany({
              where: { userId: u.id, revokedAt: null },
              data: { revokedAt: new Date() },
            }),
          ]),
      ...(active
        ? []
        : [
            this.prisma.crmWfStaffToken.updateMany({
              where: { userId: u.id, usedAt: null, revokedAt: null },
              data: { revokedAt: new Date() },
            }),
          ]),
    ]);
    await this.audit(
      tenantId,
      actor,
      active ? 'crmwf.staff.reactivated' : 'crmwf.staff.deactivated',
      u.id,
      {},
    );
    return { ok: true };
  }

  async changeRole(
    actor: Actor,
    tenantId: string,
    userId: string,
    p: { role: StaffRole; locationId?: string | null; reason?: string },
  ) {
    const u = await this.target(actor, tenantId, userId);
    this.checkGrant(actor, p.role, p.reason);
    if (p.role !== 'ADMIN' && !p.locationId && !u.locationId)
      throw new BadRequestException('choose_the_rooftop_for_this_person');
    if (p.locationId) {
      const loc = await this.prisma.location.findFirst({
        where: { id: p.locationId, tenantId },
        select: { id: true },
      });
      if (!loc) throw new ForbiddenException('Location access denied');
    }
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: u.id },
        data: {
          role: p.role as Role,
          locationId:
            p.role === 'ADMIN' ? null : (p.locationId ?? u.locationId),
        },
      }),
      // New authority takes effect at next sign-in: end current sessions.
      this.prisma.refreshToken.updateMany({
        where: { userId: u.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    await this.audit(tenantId, actor, 'crmwf.staff.role_changed', u.id, {
      from: u.role,
      to: p.role,
      reason: p.reason ?? null,
    });
    return { ok: true };
  }

  /** Public: what a link is for, without revealing anything useful to someone who guesses. */
  async describe(token: string) {
    const row = await this.valid(token);
    if (!row) return { valid: false as const };
    const [u, t] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: row.userId },
        select: { email: true, firstName: true },
      }),
      this.prisma.tenant.findUnique({
        where: { id: row.tenantId },
        select: { name: true, slug: true },
      }),
    ]);
    return {
      valid: true as const,
      purpose: row.purpose,
      firstName: u?.firstName ?? null,
      email: u ? u.email.replace(/^(.).*(@.*)$/, '$1…$2') : null,
      dealership: t?.name ?? null,
      dealershipSlug: t?.slug ?? null,
      expiresAt: row.expiresAt,
    };
  }

  private async valid(token: string) {
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return null;
    const row = await this.prisma.crmWfStaffToken.findUnique({
      where: { tokenHash: sha(token) },
    });
    if (!row || row.usedAt || row.revokedAt || row.expiresAt <= new Date())
      return null;
    return row;
  }

  /** Public: the person sets their own password. Single use; signs out any old sessions. */
  async accept(token: string, password: string) {
    if (password.length < 12)
      throw new BadRequestException('password_must_be_at_least_12_characters');
    const row = await this.valid(token);
    if (!row)
      throw new BadRequestException('this_link_is_invalid_or_has_expired');
    const hash = await bcrypt.hash(password, 12);
    const claimed = await this.prisma.crmWfStaffToken.updateMany({
      where: { id: row.id, usedAt: null, revokedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count !== 1)
      throw new BadRequestException('this_link_is_invalid_or_has_expired');
    const t = await this.prisma.tenant.findUnique({
      where: { id: row.tenantId },
      select: { slug: true },
    });
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: row.userId },
        data: { password: hash, isActive: true },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId: row.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      this.prisma.auditLog.create({
        data: {
          tenantId: row.tenantId,
          userId: row.userId,
          action:
            row.purpose === 'INVITE'
              ? 'crmwf.staff.invite_accepted'
              : 'crmwf.staff.password_set',
          resource: 'User',
          resourceId: row.userId,
        },
      }),
    ]);
    return { ok: true, dealershipSlug: t?.slug ?? null };
  }

  private audit(
    tenantId: string,
    actor: Actor,
    action: string,
    userId: string,
    metadata: object,
  ) {
    return this.prisma.auditLog.create({
      data: {
        tenantId,
        userId: actor.userId,
        action,
        resource: 'User',
        resourceId: userId,
        metadata: { ...metadata, actingRole: actor.role },
      },
    });
  }
}
