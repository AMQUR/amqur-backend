import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { auditSafe } from './vault.service';
import { CrmAdapterRegistry } from './adapters/adapter.registry';
import { Actor } from './control.service';
import { Department } from './crm-workforce.types';
import { CrmWfSuppressionService } from './suppression.service';

type Scope = { tenantId: string; locationId: string | null };

/** Human coordination: takeover / pause per lead, agent identities, connector authorization. */
@Injectable()
export class CrmWfLeadControlService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly suppression: CrmWfSuppressionService,
    private readonly adapters: CrmAdapterRegistry,
  ) {}

  /** Human takeover: immediately suspends autonomous work on this conversation. */
  async pause(actor: Actor, scope: Scope, leadId: string, reason: string) {
    const lead = await this.prisma.crmWfLead.findFirst({
      where: {
        id: leadId,
        tenantId: scope.tenantId,
        ...(scope.locationId ? { locationId: scope.locationId } : {}),
      },
    });
    if (!lead) throw new NotFoundException('lead_not_found');
    const escalated =
      lead.agentPaused && (lead.pausedReason ?? '').startsWith('escalated:');
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.crmWfLead.update({
        where: { id: leadId },
        // An escalation marker is never overwritten by a later takeover: a lead that was
        // paused because it needs a manager's decision stays that way until a manager returns it.
        data: escalated
          ? { agentPaused: true }
          : {
              agentPaused: true,
              pausedReason: reason.slice(0, 200),
              pausedByUserId: actor.userId,
            },
      });
      await this.suppression.cancelOpenWork(
        tx,
        scope.tenantId,
        leadId,
        `human_takeover:${reason}`.slice(0, 200),
      );
      await tx.auditLog.create({
        data: {
          tenantId: scope.tenantId,
          userId: actor.userId,
          action: 'crmwf.lead.takeover',
          resource: 'CrmWfLead',
          resourceId: leadId,
          metadata: auditSafe({ reason }),
        },
      });
      return row;
    });
  }

  async resume(actor: Actor, scope: Scope, leadId: string) {
    const lead = await this.prisma.crmWfLead.findFirst({
      where: {
        id: leadId,
        tenantId: scope.tenantId,
        ...(scope.locationId ? { locationId: scope.locationId } : {}),
      },
    });
    if (!lead) throw new NotFoundException('lead_not_found');
    // The employee who took the conversation can hand it back; anyone else needs a manager.
    // A lead paused by an escalation (no person took it) always needs a manager.
    const isManager = ['SUPER_ADMIN', 'ADMIN', 'MANAGER'].includes(actor.role);
    const escalated = (lead.pausedReason ?? '').startsWith('escalated:');
    if (!isManager && (escalated || lead.pausedByUserId !== actor.userId))
      throw new ForbiddenException(
        'only_the_owner_or_a_manager_can_return_this',
      );
    return this.prisma.$transaction(async (tx) => {
      // Clearing lastProcessedHash lets the next sync re-plan the lead from its current state.
      const row = await tx.crmWfLead.update({
        where: { id: leadId },
        data: {
          agentPaused: false,
          pausedReason: null,
          pausedByUserId: null,
          lastProcessedHash: null,
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId: scope.tenantId,
          userId: actor.userId,
          action: 'crmwf.lead.resumed',
          resource: 'CrmWfLead',
          resourceId: leadId,
        },
      });
      return row;
    });
  }

  async upsertProfile(
    actor: Actor,
    tenantId: string,
    p: {
      locationId: string;
      department: Department;
      displayName: string;
      title: string;
      disclosure: string;
      active?: boolean;
    },
  ) {
    if (!['SUPER_ADMIN', 'ADMIN'].includes(actor.role))
      throw new ForbiddenException('identity_change_requires_admin');
    const loc = await this.prisma.location.findFirst({
      where: { id: p.locationId, tenantId },
      select: { id: true },
    });
    if (!loc) throw new ForbiddenException('Location access denied');
    const name = p.displayName.trim();
    if (!/virtual/i.test(p.title) || !/virtual/i.test(p.disclosure))
      throw new BadRequestException('identity_must_be_disclosed_as_virtual');
    // Never the name of someone who works there.
    const employees = await this.prisma.user.findMany({
      where: { tenantId, isActive: true },
      select: { firstName: true, lastName: true },
    });
    if (
      employees.some(
        (e) =>
          `${e.firstName} ${e.lastName}`.trim().toLowerCase() ===
          name.toLowerCase(),
      )
    )
      throw new BadRequestException('identity_matches_an_employee_name');
    const key = {
      tenantId_locationId_department: {
        tenantId,
        locationId: p.locationId,
        department: p.department,
      },
    };
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.crmWfAgentProfile.upsert({
        where: key,
        create: {
          tenantId,
          locationId: p.locationId,
          department: p.department,
          displayName: name,
          title: p.title.trim(),
          disclosure: p.disclosure.trim(),
          active: p.active ?? true,
          updatedByUserId: actor.userId,
        },
        update: {
          displayName: name,
          title: p.title.trim(),
          disclosure: p.disclosure.trim(),
          active: p.active ?? true,
          version: { increment: 1 },
          updatedByUserId: actor.userId,
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          userId: actor.userId,
          action: 'crmwf.identity.changed',
          resource: 'CrmWfAgentProfile',
          resourceId: row.id,
          metadata: auditSafe({
            department: p.department,
            displayName: name,
            version: row.version,
          }),
        },
      });
      return row;
    });
  }

  async setConnector(
    actor: Actor,
    tenantId: string,
    p: {
      locationId: string;
      adapterKey: string;
      enabled: boolean;
      authorizationRef?: string;
    },
  ) {
    if (!['SUPER_ADMIN', 'ADMIN'].includes(actor.role))
      throw new ForbiddenException('connector_change_requires_admin');
    const adapter = this.adapters.get(p.adapterKey);
    if (!adapter) throw new BadRequestException('unknown_adapter');
    const loc = await this.prisma.location.findFirst({
      where: { id: p.locationId, tenantId },
      select: { id: true },
    });
    if (!loc) throw new ForbiddenException('Location access denied');
    const health = await adapter.health({ tenantId, locationId: p.locationId });
    if (p.enabled) {
      // A connector that cannot operate is never shown as enabled.
      if (health.status === 'BLOCKED')
        throw new BadRequestException(
          `adapter_blocked:${health.reason ?? 'unavailable'}`,
        );
      if (adapter.requiresAuthorization && !p.authorizationRef?.trim())
        throw new BadRequestException(
          'written_authorization_reference_required',
        );
    }
    const key = {
      tenantId_locationId_adapterKey: {
        tenantId,
        locationId: p.locationId,
        adapterKey: p.adapterKey,
      },
    };
    const auth =
      p.enabled && p.authorizationRef?.trim()
        ? {
            authorizationRef: p.authorizationRef.trim().slice(0, 200),
            authorizedAt: new Date(),
            authorizedByUserId: actor.userId,
          }
        : {};
    const status = p.enabled
      ? 'READY'
      : health.status === 'BLOCKED'
        ? 'BLOCKED'
        : 'DISABLED';
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.crmWfConnector.upsert({
        where: key,
        create: {
          tenantId,
          locationId: p.locationId,
          adapterKey: p.adapterKey,
          enabled: p.enabled,
          status,
          statusReason: health.reason ?? null,
          ...auth,
        },
        update: {
          enabled: p.enabled,
          status,
          statusReason: health.reason ?? null,
          ...auth,
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          userId: actor.userId,
          action: 'crmwf.connector.changed',
          resource: 'CrmWfConnector',
          resourceId: row.id,
          metadata: auditSafe({
            adapterKey: p.adapterKey,
            enabled: p.enabled,
            authorizationRef: row.authorizationRef,
          }),
        },
      });
      return row;
    });
  }
}
