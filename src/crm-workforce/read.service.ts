import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CrmAdapterRegistry } from './adapters/adapter.registry';
import { OPERATION_SIDE_EFFECT } from './adapters/crm-adapter';
import { PLAYBOOKS, playbookChecksum } from './agents/playbooks';
import { CrmWfControlService } from './control.service';
import { CRM_WORKFORCE_FLAG, DEPARTMENTS, envOn } from './crm-workforce.types';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';

type Scope = { tenantId: string; locationId: string | null };
const HEARTBEAT_STALE_MS = 90_000;
const mask = (s: string | null) => (s ? `${s.slice(0, 1)}…` : null);

/**
 * Read models for the Command Center. Every number is a count of real rows; when there is no
 * data the answer is zero / empty and the UI says so. Synthetic (fixture) rows are counted
 * separately and labelled DEMO. Nothing here estimates, projects or fills gaps.
 */
@Injectable()
export class CrmWfReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adapters: CrmAdapterRegistry,
    private readonly controls: CrmWfControlService,
    private readonly flags: FeatureFlagsService,
  ) {}

  private w(s: Scope) {
    return {
      tenantId: s.tenantId,
      ...(s.locationId ? { locationId: s.locationId } : {}),
    };
  }

  async status(s: Scope) {
    const [flags, controls, workers, connectors, global] = await Promise.all([
      this.flags.resolve(s.tenantId, s.locationId ?? undefined),
      this.controls.list(s.tenantId, s.locationId),
      this.prisma.crmWfHeartbeat.findMany({
        orderBy: { lastBeatAt: 'desc' },
        take: 10,
      }),
      this.prisma.crmWfConnector.findMany({ where: this.w(s) }),
      this.controls.globalHalted(),
    ]);
    const now = Date.now();
    return {
      featureFlag: !!flags[CRM_WORKFORCE_FLAG],
      processEnabled: envOn('CRM_WORKFORCE_ENABLED'),
      externalSendEnv: envOn('CRM_WORKFORCE_EXTERNAL_SEND_ENABLED'),
      emergencyStopEnv: envOn('CRM_WORKFORCE_EMERGENCY_STOP'),
      globalHalted: global,
      controls,
      workers: workers.map((h) => ({
        workerId: h.workerId,
        role: h.role,
        state:
          now - h.lastBeatAt.getTime() > HEARTBEAT_STALE_MS ? 'DOWN' : h.state,
        lastBeatAt: h.lastBeatAt,
        startedAt: h.startedAt,
      })),
      connectors: this.adapters.all().map((a) => {
        const rows = connectors.filter((c) => c.adapterKey === a.key);
        return {
          adapterKey: a.key,
          label: a.label,
          requiresAuthorization: a.requiresAuthorization,
          capabilities: Object.entries(a.capabilities()).map(
            ([operation, c]) => ({
              operation,
              sideEffect:
                OPERATION_SIDE_EFFECT[
                  operation as keyof typeof OPERATION_SIDE_EFFECT
                ],
              status: c.status,
              reason: c.reason ?? null,
            }),
          ),
          connections: rows.map((c) => ({
            id: c.id,
            locationId: c.locationId,
            enabled: c.enabled,
            status: c.status,
            statusReason: c.statusReason,
            authorizationRef: c.authorizationRef,
            authorizedAt: c.authorizedAt,
            lastHealthAt: c.lastHealthAt,
            lastSyncAt: c.lastSyncAt,
            lastError: c.lastError,
          })),
        };
      }),
    };
  }

  async overview(s: Scope) {
    const where = this.w(s);
    const [leads, synthetic, tasks, actions, suppressions, paused] =
      await Promise.all([
        this.prisma.crmWfLead.count({ where }),
        this.prisma.crmWfLead.count({ where: { ...where, synthetic: true } }),
        this.prisma.crmWfTask.groupBy({
          by: ['status', 'priority', 'department'],
          where,
          _count: { _all: true },
        }),
        this.prisma.crmWfAction.groupBy({
          by: ['status'],
          where,
          _count: { _all: true },
        }),
        this.prisma.crmWfSuppression.count({
          where: { tenantId: s.tenantId, liftedAt: null },
        }),
        this.prisma.crmWfLead.count({ where: { ...where, agentPaused: true } }),
      ]);
    return {
      dataLabel:
        leads === 0
          ? 'NO DATA'
          : synthetic === leads
            ? 'DEMO'
            : synthetic > 0
              ? 'MIXED'
              : 'CRM DATA',
      leads: { total: leads, synthetic },
      tasks: tasks.map((t) => ({
        status: t.status,
        priority: t.priority,
        department: t.department,
        count: t._count._all,
      })),
      actions: actions.map((a) => ({ status: a.status, count: a._count._all })),
      activeSuppressions: suppressions,
      pausedLeads: paused,
    };
  }

  async tasks(
    s: Scope,
    q: {
      status?: string[];
      priority?: number;
      department?: string;
      take?: number;
    },
  ) {
    const rows = await this.prisma.crmWfTask.findMany({
      where: {
        ...this.w(s),
        ...(q.status?.length ? { status: { in: q.status as never } } : {}),
        ...(q.priority !== undefined ? { priority: q.priority } : {}),
        ...(q.department ? { department: q.department as never } : {}),
      },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      take: Math.min(q.take ?? 100, 200),
    });
    const leads = await this.prisma.crmWfLead.findMany({
      where: { tenantId: s.tenantId, id: { in: rows.map((r) => r.crmLeadId) } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        leadSource: true,
        crmStatus: true,
        assignedTo: true,
        vehicleInterest: true,
        synthetic: true,
        verified: true,
        asOf: true,
        lastInboundAt: true,
        sourceRecordId: true,
        adapterKey: true,
      },
    });
    const byId = new Map(leads.map((l) => [l.id, l]));
    return rows.map((t) => {
      const l = byId.get(t.crmLeadId);
      return { ...t, lead: l ? { ...l, lastName: mask(l.lastName) } : null };
    });
  }

  async actions(s: Scope, q: { status?: string[]; take?: number }) {
    const rows = await this.prisma.crmWfAction.findMany({
      where: {
        ...this.w(s),
        ...(q.status?.length ? { status: { in: q.status as never } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(q.take ?? 100, 200),
    });
    const leads = await this.prisma.crmWfLead.findMany({
      where: {
        tenantId: s.tenantId,
        id: { in: rows.map((r) => r.crmLeadId ?? '') },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        assignedTo: true,
        synthetic: true,
        vehicleInterest: true,
      },
    });
    const byId = new Map(leads.map((l) => [l.id, l]));
    return rows.map((a) => {
      const l = byId.get(a.crmLeadId ?? '');
      return { ...a, lead: l ? { ...l, lastName: mask(l.lastName) } : null };
    });
  }

  /** One lead's full conversation + work history for the review pane (staff-only). */
  async lead(s: Scope, id: string) {
    const lead = await this.prisma.crmWfLead.findFirst({
      where: { id, ...this.w(s) },
      include: { messages: { orderBy: { occurredAt: 'asc' }, take: 200 } },
    });
    if (!lead) return null;
    const [tasks, actions] = await Promise.all([
      this.prisma.crmWfTask.findMany({
        where: { tenantId: s.tenantId, crmLeadId: id },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.prisma.crmWfAction.findMany({
        where: { tenantId: s.tenantId, crmLeadId: id },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);
    return { lead, tasks, actions };
  }

  async agents(s: Scope) {
    const profiles = await this.prisma.crmWfAgentProfile.findMany({
      where: this.w(s),
    });
    return {
      profiles,
      departments: DEPARTMENTS,
      playbooks: PLAYBOOKS.map((p) => ({
        key: p.key,
        version: p.version,
        scope: p.scope,
        agent: p.agent,
        workflows: p.workflows,
        escalate: p.escalate,
        checksum: playbookChecksum(p),
      })),
    };
  }

  audit(s: Scope, take = 200) {
    return this.prisma.auditLog.findMany({
      where: {
        action: { startsWith: 'crmwf.' },
        OR: [
          { tenantId: s.tenantId },
          ...(s.locationId ? [] : [{ tenantId: null }]),
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(take, 500),
      select: {
        id: true,
        action: true,
        resource: true,
        resourceId: true,
        metadata: true,
        userId: true,
        createdAt: true,
      },
    });
  }

  /** Business metrics per department — counts of real events only, observed vs attributed. */
  async performance(s: Scope, since: Date) {
    const where = { ...this.w(s) };
    const [
      eligible,
      processed,
      actions,
      outcomes,
      escalated,
      dupes,
      blocked,
      firstResponse,
    ] = await Promise.all([
      this.prisma.crmWfLead.groupBy({
        by: ['department', 'leadSource'],
        where: { ...where, createdAt: { gte: since } },
        _count: { _all: true },
      }),
      this.prisma.crmWfTask.groupBy({
        by: ['department', 'status'],
        where: { ...where, updatedAt: { gte: since } },
        _count: { _all: true },
      }),
      this.prisma.crmWfAction.groupBy({
        by: ['department', 'status'],
        where: { ...where, sideEffect: 'EXTERNAL', updatedAt: { gte: since } },
        _count: { _all: true },
      }),
      this.prisma.crmWfOutcome.groupBy({
        by: ['department', 'kind', 'basis', 'verified'],
        where: { ...where, occurredAt: { gte: since } },
        _count: { _all: true },
      }),
      this.prisma.crmWfTask.count({
        where: { ...where, status: 'ESCALATED', updatedAt: { gte: since } },
      }),
      // A duplicate send would be two possibly-sent message actions for one task. Expected: 0.
      this.prisma.$queryRaw<
        Array<{ n: bigint }>
      >`SELECT COUNT(*)::bigint AS n FROM (SELECT "taskId" FROM "CrmWfAction" WHERE "tenantId" = ${s.tenantId} AND "taskId" IS NOT NULL AND "sideEffect" = 'EXTERNAL'::"CrmWfSideEffect" AND "status" IN ('VERIFIED','SENT_UNVERIFIED','UNCERTAIN','STAFF_CONFIRMED') GROUP BY "taskId" HAVING COUNT(*) > 1) d`,
      this.prisma.auditLog.count({
        where: {
          tenantId: s.tenantId,
          action: 'crmwf.action.blocked',
          createdAt: { gte: since },
        },
      }),
      this.prisma.$queryRaw<
        Array<{ department: string; n: bigint; avg_seconds: number | null }>
      >`
        SELECT l."department"::text AS department, COUNT(*)::bigint AS n,
               AVG(EXTRACT(EPOCH FROM (a."verifiedAt" - l."createdInCrmAt")))::float AS avg_seconds
          FROM "CrmWfAction" a JOIN "CrmWfLead" l ON l."id" = a."crmLeadId"
         WHERE a."tenantId" = ${s.tenantId} AND a."status" = 'VERIFIED'::"CrmWfActionStatus" AND a."verifiedAt" >= ${since}
           AND l."createdInCrmAt" IS NOT NULL AND (a."payload"->>'workflow') = 'first_response'
         GROUP BY l."department"`,
    ]);
    return {
      since,
      note: 'Counts of recorded events. OBSERVED = seen in the CRM. ATTRIBUTED = credited to workforce activity. DEAL_CREATED is not a verified sale. Empty means no data, not zero performance.',
      eligibleLeads: eligible.map((r) => ({
        department: r.department,
        leadSource: r.leadSource,
        count: r._count._all,
      })),
      tasks: processed.map((r) => ({
        department: r.department,
        status: r.status,
        count: r._count._all,
      })),
      externalActions: actions.map((r) => ({
        department: r.department,
        status: r.status,
        count: r._count._all,
      })),
      outcomes: outcomes.map((r) => ({
        department: r.department,
        kind: r.kind,
        basis: r.basis,
        verified: r.verified,
        count: r._count._all,
      })),
      humanEscalations: escalated,
      duplicateSends: Number(dupes[0]?.n ?? 0),
      blockedExecutions: blocked,
      firstResponse: firstResponse.map((r) => ({
        department: r.department,
        count: Number(r.n),
        avgSeconds: r.avg_seconds,
      })),
    };
  }

  async costs(s: Scope, since: Date) {
    const where = {
      tenantId: s.tenantId,
      ...(s.locationId ? { locationId: s.locationId } : {}),
      createdAt: { gte: since },
    };
    const [byModel, leads, convos, appts] = await Promise.all([
      this.prisma.crmWfUsage.groupBy({
        by: ['kind', 'provider', 'model'],
        where,
        _sum: { inputTokens: true, outputTokens: true, costMicroUsd: true },
        _count: { _all: true },
      }),
      this.prisma.crmWfUsage.findMany({
        where,
        distinct: ['crmLeadId'],
        select: { crmLeadId: true },
      }),
      this.prisma.crmWfAction.count({
        where: {
          ...this.w(s),
          status: { in: ['VERIFIED', 'STAFF_CONFIRMED'] },
          updatedAt: { gte: since },
        },
      }),
      this.prisma.crmWfOutcome.groupBy({
        by: ['kind'],
        where: {
          ...this.w(s),
          occurredAt: { gte: since },
          kind: {
            in: ['QUALIFIED', 'APPT_SET', 'APPT_SHOWN', 'SALE_VERIFIED'],
          },
          basis: 'ATTRIBUTED',
        },
        _count: { _all: true },
      }),
    ]);
    const totalMicro = byModel.reduce(
      (n, r) => n + (r._sum.costMicroUsd ?? 0),
      0,
    );
    const per = (n: number) => (n > 0 ? Math.round(totalMicro / n) : null);
    const out = (k: string) =>
      appts.find((a) => a.kind === k)?._count._all ?? 0;
    return {
      since,
      note: 'Model cost is what the model gateway reported per call (0 when prices are not configured). Infrastructure cost is not metered here. A null unit cost means there is no denominator yet.',
      modelCostMicroUsd: totalMicro,
      calls: byModel.map((r) => ({
        kind: r.kind,
        provider: r.provider,
        model: r.model,
        calls: r._count._all,
        inputTokens: r._sum.inputTokens ?? 0,
        outputTokens: r._sum.outputTokens ?? 0,
        costMicroUsd: r._sum.costMicroUsd ?? 0,
      })),
      unitCostMicroUsd: {
        perProcessedLead: per(leads.filter((l) => l.crmLeadId).length),
        perConversation: per(convos),
        perQualifiedOpportunity: per(out('QUALIFIED')),
        perAppointment: per(out('APPT_SET')),
        perShownAppointment: per(out('APPT_SHOWN')),
        perAttributedSale: per(out('SALE_VERIFIED')),
      },
    };
  }

  async reviews(s: Scope) {
    const [rows, byLabel] = await Promise.all([
      this.prisma.crmWfReview.findMany({
        where: this.w(s),
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      this.prisma.crmWfReview.groupBy({
        by: ['label'],
        where: this.w(s),
        _count: { _all: true },
        _avg: { score: true },
      }),
    ]);
    return {
      rows,
      byLabel: byLabel.map((r) => ({
        label: r.label,
        count: r._count._all,
        avgScore: r._avg.score,
      })),
    };
  }
}
