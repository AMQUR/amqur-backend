import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ROSTER } from './agents/roster';
import { CrmWfControlService } from './control.service';
import { envOn } from './crm-workforce.types';
import { CrmWfMiningService } from './mining.service';

type Scope = { tenantId: string; locationId: string | null };
type Finding = {
  severity: 'CRITICAL' | 'HIGH' | 'NORMAL';
  area: string;
  finding: string;
  count: number;
  recommendation: string;
};
export const REPORT_KINDS = [
  'morning',
  'midday',
  'end_of_day',
  'weekly',
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
const OPEN_TASK = ['PENDING', 'CLAIMED', 'AWAITING_APPROVAL'] as const;
const HOUR = 3_600_000;

/**
 * Group Operations Director and management reporting. Deterministic queries over recorded
 * work — no model. Findings are internal recommendations for people; this service cannot
 * change a permission, a mode or a policy, and cannot start outreach.
 *
 * Reports are generated on request. Scheduled delivery to staff is not wired: the platform
 * has no approved internal notification channel configured for it yet.
 */
@Injectable()
export class CrmWfDirectorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mining: CrmWfMiningService,
    private readonly controls: CrmWfControlService,
  ) {}

  private w(s: Scope) {
    return {
      tenantId: s.tenantId,
      ...(s.locationId ? { locationId: s.locationId } : {}),
    };
  }

  /** What needs a person's attention at this rooftop, most serious first. */
  async findings(s: Scope, now = new Date()): Promise<Finding[]> {
    const w = this.w(s);
    const hourAgo = new Date(now.getTime() - HOUR);
    const weekAgo = new Date(now.getTime() - 7 * 24 * HOUR);
    const [
      waiting,
      waitingLong,
      firstResp,
      escal,
      escalOld,
      dead,
      uncertain,
      blocked,
      connectors,
      optOuts,
      contacts,
      mining,
      drafts,
    ] = await Promise.all([
      this.prisma.crmWfTask.count({
        where: { ...w, priority: 0, status: { in: [...OPEN_TASK] } },
      }),
      this.prisma.crmWfTask.count({
        where: {
          ...w,
          priority: 0,
          status: { in: [...OPEN_TASK] },
          createdAt: { lt: hourAgo },
        },
      }),
      this.prisma.crmWfTask.count({
        where: {
          ...w,
          priority: 1,
          status: { in: [...OPEN_TASK] },
          createdAt: { lt: hourAgo },
        },
      }),
      this.prisma.crmWfWorkItem.count({
        where: {
          ...w,
          kind: 'ESCALATION',
          status: { in: ['OPEN', 'IN_PROGRESS'] },
        },
      }),
      this.prisma.crmWfWorkItem.count({
        where: {
          ...w,
          kind: 'ESCALATION',
          status: 'OPEN',
          createdAt: { lt: hourAgo },
        },
      }),
      this.prisma.crmWfTask.count({ where: { ...w, status: 'DEAD' } }),
      this.prisma.crmWfAction.count({
        where: { ...w, status: { in: ['UNCERTAIN', 'SENT_UNVERIFIED'] } },
      }),
      this.prisma.crmWfAction.count({
        where: { ...w, status: 'BLOCKED', updatedAt: { gte: weekAgo } },
      }),
      this.prisma.crmWfConnector.findMany({ where: { ...w, enabled: true } }),
      this.prisma.crmWfSuppression.count({
        where: {
          tenantId: s.tenantId,
          source: 'INBOUND_MESSAGE',
          createdAt: { gte: weekAgo },
        },
      }),
      this.prisma.crmWfAction.count({
        where: {
          ...w,
          status: { in: ['VERIFIED', 'STAFF_CONFIRMED'] },
          updatedAt: { gte: weekAgo },
        },
      }),
      this.mining.summary(s, now),
      this.prisma.crmWfAction.count({
        where: {
          ...w,
          status: { in: ['DRAFT', 'PENDING_APPROVAL'] },
          createdAt: { lt: new Date(now.getTime() - 4 * HOUR) },
        },
      }),
    ]);
    const q = (id: string) => mining.find((m) => m.id === id)?.count ?? 0;
    const out: Finding[] = [];
    const add = (f: Finding) => f.count > 0 && out.push(f);
    add({
      severity: 'CRITICAL',
      area: 'Customers',
      count: waitingLong,
      finding: 'Customers have waited over an hour for a reply.',
      recommendation:
        'Open Unanswered customer messages and reply or assign now.',
    });
    add({
      severity: 'CRITICAL',
      area: 'Escalations',
      count: escalOld,
      finding: 'Escalations have had no owner for over an hour.',
      recommendation: 'A manager should pick these up in Work items.',
    });
    add({
      severity: 'CRITICAL',
      area: 'Sending',
      count: uncertain,
      finding: 'Messages have an unknown send result.',
      recommendation: 'Check the CRM for each before anything is re-sent.',
    });
    add({
      severity: 'HIGH',
      area: 'Customers',
      count: waiting - waitingLong,
      finding: 'Customers are waiting on a reply.',
      recommendation: 'Work the top of the queue.',
    });
    add({
      severity: 'HIGH',
      area: 'New leads',
      count: firstResp,
      finding: 'New leads have had no first response for over an hour.',
      recommendation:
        'Respond, or review consent where the lead is held for it.',
    });
    add({
      severity: 'HIGH',
      area: 'Appointments',
      count: q('missed_appointments'),
      finding: 'Missed appointments are still open.',
      recommendation: 'Offer a new time while the customer is still shopping.',
    });
    add({
      severity: 'HIGH',
      area: 'System',
      count: dead,
      finding: 'Tasks failed repeatedly and stopped.',
      recommendation: 'Review under Errors; replay after the cause is fixed.',
    });
    add({
      severity: 'HIGH',
      area: 'CRM connection',
      count: connectors.filter((c) => c.status !== 'READY').length,
      finding: 'A CRM connection is not ready.',
      recommendation: 'See CRM connections and workers.',
    });
    add({
      severity: 'NORMAL',
      area: 'Escalations',
      count: escal - escalOld,
      finding: 'Escalations are open.',
      recommendation: 'Confirm each has an owner.',
    });
    add({
      severity: 'NORMAL',
      area: 'Approvals',
      count: drafts,
      finding: 'Drafts have waited over four hours for review.',
      recommendation:
        'Approve, edit or reject them; stale replies lose the customer.',
    });
    add({
      severity: 'NORMAL',
      area: 'Follow-up',
      count: q('no_followup'),
      finding: 'Open leads have no follow-up scheduled in the CRM.',
      recommendation: 'Set a next step for each owner.',
    });
    add({
      severity: 'NORMAL',
      area: 'Follow-up',
      count: q('visited_unsold'),
      finding: 'Showroom visitors are still unsold.',
      recommendation: 'Post-visit follow-up by the salesperson who met them.',
    });
    add({
      severity: 'NORMAL',
      area: 'Compliance',
      count: blocked,
      finding: 'Sends were blocked by policy this week.',
      recommendation:
        'Review the reasons under Draft approvals → Blocked or failed.',
    });
    // An opt-out rate needs a denominator; with too few contacts it is noise, not a signal.
    if (contacts >= 20 && optOuts / contacts > 0.05)
      out.push({
        severity: 'HIGH',
        area: 'Compliance',
        count: optOuts,
        finding: `Opt-outs are ${Math.round((optOuts / contacts) * 100)}% of confirmed contacts this week.`,
        recommendation:
          'Pause outbound workflows for this rooftop and review the messages sent.',
      });
    const rank = { CRITICAL: 0, HIGH: 1, NORMAL: 2 };
    return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
  }

  /** Each role with its live, recorded state. No role is shown as active without evidence. */
  async roster(s: Scope, now = new Date()) {
    const w = this.w(s);
    const dayAgo = new Date(now.getTime() - 24 * HOUR);
    const [
      tasks,
      lastOk,
      errors,
      items,
      awaiting,
      mining,
      heartbeats,
      connectors,
      controls,
      lastAudit,
    ] = await Promise.all([
      this.prisma.crmWfTask.groupBy({
        by: ['agentKey', 'workflowKey', 'status'],
        where: w,
        _count: { _all: true },
      }),
      this.prisma.crmWfTask.groupBy({
        by: ['agentKey', 'workflowKey'],
        where: { ...w, status: { in: ['DONE', 'AWAITING_APPROVAL'] } },
        _max: { updatedAt: true },
      }),
      this.prisma.crmWfTask.groupBy({
        by: ['agentKey', 'workflowKey'],
        where: {
          ...w,
          status: { in: ['DEAD', 'FAILED'] },
          updatedAt: { gte: dayAgo },
        },
        _count: { _all: true },
      }),
      this.prisma.crmWfWorkItem.groupBy({
        by: ['kind', 'status'],
        where: w,
        _count: { _all: true },
        _max: { updatedAt: true },
      }),
      this.prisma.crmWfAction.groupBy({
        by: ['status'],
        where: { ...w, status: { in: ['DRAFT', 'PENDING_APPROVAL'] } },
        _count: { _all: true },
      }),
      this.mining.summary(s, now),
      this.prisma.crmWfHeartbeat.findMany({
        orderBy: { lastBeatAt: 'desc' },
        take: 5,
      }),
      this.prisma.crmWfConnector.findMany({ where: { ...w, enabled: true } }),
      this.controls.list(s.tenantId, s.locationId),
      this.prisma.auditLog.findFirst({
        where: { tenantId: s.tenantId, action: { startsWith: 'crmwf.' } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
    ]);
    const loc = controls.find(
      (c) =>
        c.scope === 'LOCATION' &&
        (!s.locationId || c.locationId === s.locationId),
    );
    const halted =
      envOn('CRM_WORKFORCE_EMERGENCY_STOP') ||
      controls.some(
        (c) =>
          c.halted &&
          (c.scope === 'GLOBAL' ||
            c.scope === 'TENANT' ||
            c.scope === 'LOCATION'),
      );
    const workerLive = heartbeats.some(
      (h) =>
        now.getTime() - h.lastBeatAt.getTime() < 90_000 &&
        h.state === 'RUNNING',
    );
    const awaitingApproval = awaiting.reduce((n, a) => n + a._count._all, 0);
    return ROSTER.map((r) => {
      let workload = 0;
      let last: Date | null = null;
      let recentErrors = 0;
      const src = r.source;
      if (src.type === 'tasks') {
        const m = (t: { agentKey: string; workflowKey: string }) =>
          (!src.agentKeys || src.agentKeys.includes(t.agentKey)) &&
          (!src.workflows || src.workflows.includes(t.workflowKey));
        workload = tasks
          .filter(
            (t) => m(t) && (OPEN_TASK as readonly string[]).includes(t.status),
          )
          .reduce((n, t) => n + t._count._all, 0);
        last =
          lastOk
            .filter(m)
            .map((t) => t._max.updatedAt)
            .filter((d): d is Date => !!d)
            .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
        recentErrors = errors.filter(m).reduce((n, t) => n + t._count._all, 0);
      } else if (src.type === 'workItems') {
        const mine = items.filter((i) => src.kinds.includes(i.kind));
        workload = mine
          .filter((i) => ['OPEN', 'IN_PROGRESS'].includes(i.status))
          .reduce((n, i) => n + i._count._all, 0);
        last =
          mine
            .map((i) => i._max.updatedAt)
            .filter((d): d is Date => !!d)
            .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
      } else if (src.type === 'mining') {
        workload = mining
          .filter((q) => src.queues.includes(q.id))
          .reduce((n, q) => n + q.count, 0);
      } else if (src.type === 'audit') {
        last = lastAudit?.createdAt ?? null;
      }
      return {
        key: r.key,
        name: r.name,
        scope: r.scope,
        responsibility: r.responsibility,
        runsOn: r.runsOn,
        limits: r.limits,
        mode: loc?.mode ?? 'OBSERVE',
        // Stated from switches and heartbeats, never assumed.
        state: halted
          ? 'STOPPED'
          : !envOn('CRM_WORKFORCE_ENABLED')
            ? 'ENGINE OFF'
            : workerLive
              ? 'RUNNING'
              : 'NO WORKER',
        authorization:
          loc?.externalSendEnabled === true &&
          envOn('CRM_WORKFORCE_EXTERNAL_SEND_ENABLED')
            ? 'May send within policy'
            : 'Internal work only — no customer sending',
        connection: connectors.length
          ? connectors.map((c) => `${c.adapterKey}: ${c.status}`).join(', ')
          : 'No CRM connection',
        workload,
        awaitingApproval: r.runsOn === 'model' ? awaitingApproval : 0,
        lastSuccessfulAt: last,
        recentErrors,
      };
    });
  }

  async report(s: Scope, kind: string, now = new Date()) {
    if (!(REPORT_KINDS as readonly string[]).includes(kind))
      throw new BadRequestException('unknown_report');
    const w = this.w(s);
    const hours =
      kind === 'weekly'
        ? 168
        : kind === 'morning'
          ? 16
          : kind === 'midday'
            ? 6
            : 24;
    const since = new Date(now.getTime() - hours * HOUR);
    const [
      inbound,
      newLeads,
      openByPriority,
      items,
      actions,
      outcomes,
      optOuts,
      usage,
      findings,
      apptsToday,
    ] = await Promise.all([
      this.prisma.crmWfLead.count({
        where: { ...w, lastInboundAt: { gte: since } },
      }),
      this.prisma.crmWfLead.count({
        where: { ...w, createdInCrmAt: { gte: since } },
      }),
      this.prisma.crmWfTask.groupBy({
        by: ['priority'],
        where: { ...w, status: { in: [...OPEN_TASK] } },
        _count: { _all: true },
      }),
      this.prisma.crmWfWorkItem.groupBy({
        by: ['kind', 'status'],
        where: {
          ...w,
          OR: [
            { status: { in: ['OPEN', 'IN_PROGRESS'] } },
            { updatedAt: { gte: since } },
          ],
        },
        _count: { _all: true },
      }),
      this.prisma.crmWfAction.groupBy({
        by: ['status'],
        where: { ...w, updatedAt: { gte: since } },
        _count: { _all: true },
      }),
      this.prisma.crmWfOutcome.groupBy({
        by: ['kind', 'basis', 'verified'],
        where: { ...w, occurredAt: { gte: since } },
        _count: { _all: true },
      }),
      this.prisma.crmWfSuppression.count({
        where: { tenantId: s.tenantId, createdAt: { gte: since } },
      }),
      this.prisma.crmWfUsage.aggregate({
        where: {
          tenantId: s.tenantId,
          ...(s.locationId ? { locationId: s.locationId } : {}),
          createdAt: { gte: since },
        },
        _sum: { costMicroUsd: true },
        _count: { _all: true },
      }),
      this.findings(s, now),
      this.prisma.crmWfLead.count({
        where: {
          ...w,
          appointmentState: 'SCHEDULED',
          appointmentAt: { gte: now, lte: new Date(now.getTime() + 24 * HOUR) },
        },
      }),
    ]);
    const act = (st: string) =>
      actions.find((a) => a.status === st)?._count._all ?? 0;
    return {
      kind,
      generatedAt: now,
      periodHours: hours,
      note: 'Counts of recorded events for the period. Outcomes are labelled observed or attributed, and from-CRM or not. An empty section means nothing was recorded.',
      customers: {
        repliesReceived: inbound,
        newLeads,
        waitingOnReply:
          openByPriority.find((p) => p.priority === 0)?._count._all ?? 0,
        appointmentsNext24h: apptsToday,
      },
      openWorkByPriority: openByPriority
        .map((p) => ({ priority: p.priority, count: p._count._all }))
        .sort((a, b) => a.priority - b.priority),
      staffWorkItems: items.map((i) => ({
        kind: i.kind,
        status: i.status,
        count: i._count._all,
      })),
      messages: {
        draftsWaiting: act('DRAFT') + act('PENDING_APPROVAL'),
        sentConfirmedInCrm: act('VERIFIED'),
        sentByEmployees: act('STAFF_CONFIRMED'),
        unknownResult: act('UNCERTAIN') + act('SENT_UNVERIFIED'),
        blocked: act('BLOCKED'),
      },
      outcomes: outcomes.map((o) => ({
        kind: o.kind,
        basis: o.basis,
        fromCrm: o.verified,
        count: o._count._all,
      })),
      compliance: { optOutsRecorded: optOuts },
      cost: {
        modelCalls: usage._count._all,
        modelCostMicroUsd: usage._sum.costMicroUsd ?? 0,
      },
      needsAttention: findings,
    };
  }
}
