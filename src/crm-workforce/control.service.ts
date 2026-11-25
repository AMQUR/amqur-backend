import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
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

export type Actor = { userId: string; role: string; tenantId: string };

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
          metadata: {
            version: clean.version,
            legallyApproved: !!approved,
            documentRef: approved?.documentRef ?? null,
            reason: why,
          },
        },
      });
      return clean;
    });
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
            ([k]) => k === 'policy' || k === 'policyLegalApproval',
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
          metadata: {
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
          },
        },
      });
      return row;
    });
  }
}
