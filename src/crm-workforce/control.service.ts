import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { auditSafe } from './vault.service';
import { Department, OperatingMode } from './crm-workforce.types';
import {
  CompliancePolicy,
  DEFAULT_POLICY,
  sanitizePolicy,
} from './policy/compliance.engine';
import {
  ControlRow,
  ControlTarget,
  EffectiveControl,
  isCompleteAuthorization,
  pathKeys,
  resolveControl,
  scopeKeys,
} from './policy/controls';

export type Actor = {
  userId: string;
  role: string;
  tenantId: string;
  /** Set when acting in another dealership through a group membership. */
  groupActing?: boolean;
};

export type SetControlInput = {
  scope: ControlRow['scope'];
  tenantId?: string;
  locationId?: string;
  department?: Department;
  subjectKey?: string;
  halted?: boolean;
  mode?: OperatingMode;
  externalSendEnabled?: boolean;
  authorization?: Record<string, unknown> | null;
  reason: string;
};

/**
 * Kill switches, pauses and operating modes. Read fresh from the database on every decision
 * (no cache) so a stop takes effect on the very next check, in every process.
 */
@Injectable()
export class CrmWfControlService {
  constructor(private readonly prisma: PrismaService) {}

  async effective(target: ControlTarget): Promise<EffectiveControl> {
    const rows = await this.prisma.crmWfControl.findMany({
      where: { scopeKey: { in: pathKeys(target) } },
    });
    return resolveControl(target, rows as unknown as ControlRow[]);
  }

  async globalHalted(): Promise<boolean> {
    const g = await this.prisma.crmWfControl.findUnique({
      where: { scopeKey: scopeKeys.global() },
    });
    return !!g?.halted;
  }

  /**
   * Compliance policy for a tenant. Stored on the TENANT control row under the reserved
   * `policy` / `policyLegalApproval` keys, which ONLY `setPolicy` (SUPER_ADMIN) can write —
   * the general `set` method refuses them. Read back through the same validator, so a bad
   * row can only ever fall back to defaults (which are not approved for sending).
   */
  async policyFor(tenantId: string): Promise<CompliancePolicy> {
    const row = await this.prisma.crmWfControl.findUnique({
      where: { scopeKey: scopeKeys.tenant(tenantId) },
    });
    const a = (row?.authorization ?? null) as {
      policy?: unknown;
      policyLegalApproval?: CompliancePolicy['legalApproval'];
    } | null;
    return a?.policy
      ? sanitizePolicy(a.policy, a.policyLegalApproval ?? null)
      : DEFAULT_POLICY;
  }

  /** Platform operator records the counsel-approved policy for a tenant. SUPER_ADMIN only. */
  async setPolicy(
    actor: Actor,
    tenantId: string,
    policy: unknown,
    legalApproval: CompliancePolicy['legalApproval'],
    reason: string,
  ) {
    if (actor.role !== 'SUPER_ADMIN')
      throw new ForbiddenException('policy_change_requires_platform_operator');
    if (!reason?.trim()) throw new BadRequestException('reason_required');
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    if (!tenant) throw new BadRequestException('unknown_tenant');
    const clean = sanitizePolicy(policy, legalApproval);
    const scopeKey = scopeKeys.tenant(tenantId);
    const existing = await this.prisma.crmWfControl.findUnique({
      where: { scopeKey },
    });
    const { legalApproval: approved, ...stored } = clean;
    const authorization = {
      ...((existing?.authorization as object | null) ?? {}),
      policy: stored,
      policyLegalApproval: approved,
    } as Prisma.InputJsonValue;
    const why = reason.trim().slice(0, 500);
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.crmWfControl.upsert({
        where: { scopeKey },
        create: {
          scope: 'TENANT',
          scopeKey,
          tenantId,
          authorization,
          reason: why,
          updatedByUserId: actor.userId,
        },
        update: { authorization, reason: why, updatedByUserId: actor.userId },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          userId: actor.userId,
          action: 'crmwf.policy.changed',
          resource: 'CrmWfControl',
          resourceId: row.id,
          metadata: auditSafe({
            version: clean.version,
            legallyApproved: !!approved,
            documentRef: approved?.documentRef ?? null,
            reason: why,
          }),
        },
      });
      return clean;
    });
  }

  /**
   * Per-dealership cost limits, set by its administrators from the Command Center. They can only
   * tighten the platform limits (CRM_WORKFORCE_DAILY_DRAFT_LIMIT / _DAILY_BUDGET_MICRO_USD),
   * never raise them. Stored under the reserved `costLimits` key of the TENANT control row.
   */
  async costLimits(tenantId: string) {
    const row = await this.prisma.crmWfControl.findUnique({
      where: { scopeKey: scopeKeys.tenant(tenantId) },
    });
    const c =
      (
        (row?.authorization ?? {}) as {
          costLimits?: {
            dailyDraftLimit?: number;
            dailyBudgetMicroUsd?: number;
          };
        }
      ).costLimits ?? {};
    const platformDrafts = Math.max(
      0,
      Number(process.env.CRM_WORKFORCE_DAILY_DRAFT_LIMIT ?? 500),
    );
    const platformBudget = Math.max(
      0,
      Number(process.env.CRM_WORKFORCE_DAILY_BUDGET_MICRO_USD ?? 0),
    );
    const drafts =
      typeof c.dailyDraftLimit === 'number'
        ? Math.min(c.dailyDraftLimit, platformDrafts)
        : platformDrafts;
    const budget =
      typeof c.dailyBudgetMicroUsd === 'number' && c.dailyBudgetMicroUsd > 0
        ? platformBudget > 0
          ? Math.min(c.dailyBudgetMicroUsd, platformBudget)
          : c.dailyBudgetMicroUsd
        : platformBudget;
    return {
      dailyDraftLimit: drafts,
      dailyBudgetMicroUsd: budget,
      dealershipSetting: c,
      platform: {
        dailyDraftLimit: platformDrafts,
        dailyBudgetMicroUsd: platformBudget,
      },
    };
  }

  async setCostLimits(
    actor: Actor,
    tenantId: string,
    p: { dailyDraftLimit?: number | null; dailyBudgetMicroUsd?: number | null },
  ) {
    if (!['SUPER_ADMIN', 'ADMIN'].includes(actor.role))
      throw new ForbiddenException('cost_limits_require_admin');
    const ok = (v: unknown, max: number) =>
      v === null ||
      v === undefined ||
      (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max);
    if (
      !ok(p.dailyDraftLimit, 100_000) ||
      !ok(p.dailyBudgetMicroUsd, 10_000_000_000)
    )
      throw new BadRequestException('invalid_cost_limit');
    const scopeKey = scopeKeys.tenant(tenantId);
    const existing = await this.prisma.crmWfControl.findUnique({
      where: { scopeKey },
    });
    const costLimits = {
      ...(typeof p.dailyDraftLimit === 'number'
        ? { dailyDraftLimit: p.dailyDraftLimit }
        : {}),
      ...(typeof p.dailyBudgetMicroUsd === 'number'
        ? { dailyBudgetMicroUsd: p.dailyBudgetMicroUsd }
        : {}),
    };
    const authorization = {
      ...((existing?.authorization as object | null) ?? {}),
      costLimits,
    } as Prisma.InputJsonValue;
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.crmWfControl.upsert({
        where: { scopeKey },
        create: {
          scope: 'TENANT',
          scopeKey,
          tenantId,
          authorization,
          reason: 'cost limits',
          updatedByUserId: actor.userId,
        },
        update: { authorization, updatedByUserId: actor.userId },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          userId: actor.userId,
          action: 'crmwf.cost_limits.changed',
          resource: 'CrmWfControl',
          resourceId: row.id,
          metadata: costLimits,
        },
      });
    });
    return this.costLimits(tenantId);
  }

  /**
   * Stop (or resume) every dealership in the caller's group at once. Needs GROUP_ADMIN on a
   * membership whose group contains the caller's own dealership. Stopping is always allowed to
   * such a member; it only ever halts work, it never enables anything.
   */
  async setGroupHalt(
    actor: Actor & { homeTenantId: string },
    halted: boolean,
    reason: string,
  ) {
    if (!reason?.trim()) throw new BadRequestException('reason_required');
    const home = await this.prisma.tenant.findUnique({
      where: { id: actor.homeTenantId },
      select: { dealerGroupId: true },
    });
    const m = home?.dealerGroupId
      ? await this.prisma.dealerGroupMembership.findUnique({
          where: {
            dealerGroupId_userId: {
              dealerGroupId: home.dealerGroupId,
              userId: actor.userId,
            },
          },
        })
      : null;
    if (!m || m.role !== 'GROUP_ADMIN')
      throw new ForbiddenException('group_stop_requires_group_admin');
    const tenants = await this.prisma.tenant.findMany({
      where: { dealerGroupId: home!.dealerGroupId },
      select: { id: true, name: true },
    });
    for (const t of tenants)
      await this.set(
        { userId: actor.userId, role: 'ADMIN', tenantId: t.id },
        {
          scope: 'TENANT',
          tenantId: t.id,
          halted,
          reason: `group ${halted ? 'stop' : 'resume'}: ${reason}`,
        },
      );
    return { dealerships: tenants.map((t) => t.name), halted };
  }

  list(tenantId: string, locationId?: string | null) {
    return this.prisma.crmWfControl.findMany({
      where: {
        OR: [
          { scope: 'GLOBAL' },
          {
            tenantId,
            ...(locationId
              ? { OR: [{ locationId }, { locationId: null }] }
              : {}),
          },
        ],
      },
      orderBy: { scopeKey: 'asc' },
    });
  }

  async set(actor: Actor, input: SetControlInput) {
    if (!input.reason?.trim()) throw new BadRequestException('reason_required');
    const isAdmin = actor.role === 'SUPER_ADMIN' || actor.role === 'ADMIN';
    const tenantId =
      input.scope === 'GLOBAL' ? null : (input.tenantId ?? actor.tenantId);

    if (input.scope === 'GLOBAL') {
      if (actor.role !== 'SUPER_ADMIN')
        throw new ForbiddenException('global_control_requires_super_admin');
    } else if (actor.role !== 'SUPER_ADMIN' && tenantId !== actor.tenantId) {
      throw new ForbiddenException('Cross-tenant access denied');
    }
    // Anyone on staff may STOP. Only admins may loosen: raise a mode, enable sending, un-halt.
    const loosening =
      input.externalSendEnabled === true ||
      input.halted === false ||
      (input.mode !== undefined && input.mode !== 'OBSERVE') ||
      input.authorization != null;
    if (
      loosening &&
      !isAdmin &&
      !(
        actor.role === 'MANAGER' &&
        input.scope !== 'GLOBAL' &&
        input.scope !== 'TENANT' &&
        input.externalSendEnabled !== true &&
        input.mode !== 'CONTROLLED_AUTONOMOUS' &&
        input.authorization == null
      )
    )
      throw new ForbiddenException('loosening_a_control_requires_admin');

    const needLoc = [
      'LOCATION',
      'DEPARTMENT',
      'WORKFLOW',
      'SALESPERSON',
    ].includes(input.scope);
    if (needLoc && !input.locationId)
      throw new BadRequestException('locationId_required');
    if (needLoc) {
      const loc = await this.prisma.location.findFirst({
        where: { id: input.locationId, tenantId: tenantId! },
        select: { id: true },
      });
      if (!loc) throw new ForbiddenException('Location access denied');
    }
    let scopeKey: string;
    switch (input.scope) {
      case 'GLOBAL':
        scopeKey = scopeKeys.global();
        break;
      case 'TENANT':
        scopeKey = scopeKeys.tenant(tenantId!);
        break;
      case 'LOCATION':
        scopeKey = scopeKeys.location(tenantId!, input.locationId!);
        break;
      case 'DEPARTMENT':
        if (!input.department)
          throw new BadRequestException('department_required');
        scopeKey = scopeKeys.department(
          tenantId!,
          input.locationId!,
          input.department,
        );
        break;
      case 'WORKFLOW':
        if (!input.subjectKey)
          throw new BadRequestException('workflow_required');
        scopeKey = scopeKeys.workflow(
          tenantId!,
          input.locationId!,
          input.subjectKey,
        );
        break;
      default:
        if (!input.subjectKey)
          throw new BadRequestException('salesperson_required');
        scopeKey = scopeKeys.salesperson(
          tenantId!,
          input.locationId!,
          input.subjectKey,
        );
    }
    if (
      input.mode === 'CONTROLLED_AUTONOMOUS' &&
      input.scope === 'WORKFLOW' &&
      !isCompleteAuthorization(input.authorization)
    )
      throw new BadRequestException(
        'controlled_autonomous_requires_complete_workflow_authorization',
      );

    const existing = await this.prisma.crmWfControl.findUnique({
      where: { scopeKey },
    });
    // The compliance-policy keys are reserved: never accepted here, always carried over.
    if (
      input.authorization &&
      ('policy' in input.authorization ||
        'costLimits' in input.authorization ||
        'policyLegalApproval' in input.authorization)
    )
      throw new BadRequestException(
        'policy_is_set_through_the_policy_endpoint_only',
      );
    const prior = (existing?.authorization ?? null) as Record<
      string,
      unknown
    > | null;
    const reserved = prior
      ? Object.fromEntries(
          Object.entries(prior).filter(
            ([k]) =>
              k === 'policy' ||
              k === 'policyLegalApproval' ||
              k === 'costLimits',
          ),
        )
      : {};
    if (input.authorization !== undefined && Object.keys(reserved).length)
      input = {
        ...input,
        authorization: { ...(input.authorization ?? {}), ...reserved },
      };
    const data = {
      halted: input.halted ?? existing?.halted ?? false,
      // Only a LOCATION row has defaults; every other scope states an opinion only when asked.
      mode:
        input.mode ??
        existing?.mode ??
        (input.scope === 'LOCATION' ? ('OBSERVE' as const) : null),
      externalSendEnabled:
        input.externalSendEnabled ??
        existing?.externalSendEnabled ??
        (input.scope === 'LOCATION' ? false : null),
      authorization:
        input.authorization === undefined
          ? (existing?.authorization ?? Prisma.JsonNull)
          : input.authorization === null
            ? Prisma.JsonNull
            : (input.authorization as Prisma.InputJsonValue),
      reason: input.reason.trim().slice(0, 500),
      updatedByUserId: actor.userId,
    };
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.crmWfControl.upsert({
        where: { scopeKey },
        create: {
          scope: input.scope,
          scopeKey,
          tenantId,
          locationId: needLoc ? input.locationId! : null,
          department: input.scope === 'DEPARTMENT' ? input.department! : null,
          subjectKey: ['WORKFLOW', 'SALESPERSON'].includes(input.scope)
            ? input.subjectKey!
            : null,
          ...data,
        },
        update: data,
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          userId: actor.userId,
          action: 'crmwf.control.changed',
          resource: 'CrmWfControl',
          resourceId: row.id,
          metadata: auditSafe({
            scopeKey,
            before: existing
              ? {
                  halted: existing.halted,
                  mode: existing.mode,
                  externalSendEnabled: existing.externalSendEnabled,
                }
              : null,
            after: {
              halted: row.halted,
              mode: row.mode,
              externalSendEnabled: row.externalSendEnabled,
            },
            reason: data.reason,
          }),
        },
      });
      return row;
    });
  }
}
