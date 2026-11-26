import { AgentKey, Department, WorkflowKey } from '../crm-workforce.types';
import { InboundSignal } from '../policy/inbound-signals';

/**
 * Lead prioritisation — configurable, deterministic, evidence-keeping.
 *
 *   P0 active customer replies            P4 missed appointments / visited-unsold
 *   P1 new inbound leads, no response     P5 engaged leads needing follow-up
 *   P2 appointment changes                P6 overdue follow-up
 *   P3 immediate purchase intent          P7 eligible older-lead reactivation
 *
 * Inputs are CRM operational facts only. No protected characteristic or sensitive personal
 * attribute is read, and none exists on the input type. Volume is not conversion potential:
 * recovery work is capped per run by the engine, never by "how many leads exist".
 */
export type LeadFacts = {
  department: Department;
  crmStatus: string | null;
  leadSource: string | null;
  createdInCrmAt: Date | null;
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
  hasFutureFollowUp: boolean;
  appointmentState: string;
  appointmentAt: Date | null;
  visitedAt: Date | null;
  /** Signals read from the latest unanswered inbound message. */
  inboundSignals: InboundSignal[];
  /** Outbound attempts since the customer's last reply. */
  unansweredAttempts: number;
  /** Vehicle of interest is verified in stock again (inventory feed), when known. */
  vehicleAvailableAgain: boolean | null;
};

export type PriorityConfig = {
  newLeadWindowHours: number;
  missedAppointmentWindowDays: number;
  visitedUnsoldWindowDays: number;
  engagedWindowDays: number;
  overdueAfterDays: number;
  reactivationMinAgeDays: number;
  reactivationMaxAgeDays: number;
  closedStatuses: string[];
};

export const DEFAULT_PRIORITY_CONFIG: PriorityConfig = {
  newLeadWindowHours: 72,
  missedAppointmentWindowDays: 14,
  visitedUnsoldWindowDays: 14,
  engagedWindowDays: 14,
  overdueAfterDays: 3,
  reactivationMinAgeDays: 30,
  reactivationMaxAgeDays: 365,
  closedStatuses: [
    'sold',
    'delivered',
    'lost',
    'dead',
    'duplicate',
    'spam',
    'bad',
  ],
};

export type Evidence = {
  rule: string;
  facts: Record<string, string | number | boolean | null>;
};

export type PriorityResult = {
  priority: number;
  workflowKey: WorkflowKey;
  agentKey: AgentKey;
  segment: string;
  evidence: Evidence[];
};

const DAY = 86_400_000;
const iso = (d: Date | null) => (d ? d.toISOString() : null);

const DEPT_AGENT: Record<Department, AgentKey> = {
  SALES: 'sales_bdc',
  SERVICE: 'service_bdc',
  PARTS: 'parts_bdc',
};

/** Returns null when no work is warranted (closed, or nothing actionable). */
export function prioritize(
  f: LeadFacts,
  now: Date,
  cfg: PriorityConfig = DEFAULT_PRIORITY_CONFIG,
): PriorityResult | null {
  const status = (f.crmStatus ?? '').trim().toLowerCase();
  const closed = cfg.closedStatuses.includes(status);
  const awaitingReply =
    !!f.lastInboundAt &&
    (!f.lastOutboundAt || f.lastInboundAt > f.lastOutboundAt);
  const base = {
    lastInboundAt: iso(f.lastInboundAt),
    lastOutboundAt: iso(f.lastOutboundAt),
  };
  const dept = DEPT_AGENT[f.department];
  const ageDays = f.createdInCrmAt
    ? (now.getTime() - f.createdInCrmAt.getTime()) / DAY
    : null;

  // P0–P3: the customer is waiting. Unanswered inbound always beats outbound campaigns,
  // even on a "closed" lead — a customer who writes back deserves an answer or a handoff.
  if (awaitingReply) {
    if (f.inboundSignals.includes('APPOINTMENT_CHANGE'))
      return {
        priority: 2,
        workflowKey: 'appointment_change',
        agentKey: 'appointment_manager',
        segment: 'appointment_change',
        evidence: [
          {
            rule: 'P2.inbound_appointment_change',
            facts: { ...base, appointmentState: f.appointmentState },
          },
        ],
      };
    if (f.inboundSignals.includes('PURCHASE_INTENT'))
      return {
        priority: 3,
        workflowKey: 'purchase_intent',
        agentKey: dept,
        segment: 'purchase_intent',
        evidence: [{ rule: 'P3.inbound_purchase_intent', facts: base }],
      };
    return {
      priority: 0,
      workflowKey: 'reply_inbound',
      agentKey: 'conversation_manager',
      segment: 'unanswered_inbound',
      evidence: [{ rule: 'P0.unanswered_inbound', facts: base }],
    };
  }

  if (closed) return null;

  const neverContacted = !f.lastOutboundAt && !f.lastInboundAt;
  if (
    neverContacted &&
    ageDays !== null &&
    ageDays * 24 <= cfg.newLeadWindowHours
  )
    return {
      priority: 1,
      workflowKey: 'first_response',
      agentKey: dept,
      segment: 'new_lead',
      evidence: [
        {
          rule: 'P1.new_lead_no_response',
          facts: {
            createdInCrmAt: iso(f.createdInCrmAt),
            leadSource: f.leadSource,
          },
        },
      ],
    };

  const since = (d: Date | null) =>
    d ? (now.getTime() - d.getTime()) / DAY : null;

  if (
    f.appointmentState === 'MISSED' &&
    (since(f.appointmentAt) ?? Infinity) <= cfg.missedAppointmentWindowDays
  )
    return {
      priority: 4,
      workflowKey: 'missed_appointment',
      agentKey: 'appointment_manager',
      segment: 'missed_appointment',
      evidence: [
        {
          rule: 'P4.missed_appointment',
          facts: { appointmentAt: iso(f.appointmentAt) },
        },
      ],
    };

  if (
    f.visitedAt &&
    (since(f.visitedAt) ?? Infinity) <= cfg.visitedUnsoldWindowDays
  )
    return {
      priority: 4,
      workflowKey: 'visited_unsold',
      agentKey: dept,
      segment: 'visited_unsold',
      evidence: [
        {
          rule: 'P4.visited_unsold',
          facts: { visitedAt: iso(f.visitedAt), crmStatus: f.crmStatus },
        },
      ],
    };

  const lastTouch =
    [f.lastInboundAt, f.lastOutboundAt]
      .filter((d): d is Date => !!d)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const idleDays = since(lastTouch);

  if (f.lastInboundAt && idleDays !== null && !f.hasFutureFollowUp) {
    if (idleDays >= cfg.overdueAfterDays && idleDays <= cfg.engagedWindowDays)
      return {
        priority: 5,
        workflowKey: 'engaged_followup',
        agentKey: dept,
        segment: 'engaged_stopped_responding',
        evidence: [
          {
            rule: 'P5.engaged_needs_followup',
            facts: {
              ...base,
              idleDays: Math.floor(idleDays),
              unansweredAttempts: f.unansweredAttempts,
            },
          },
        ],
      };
  }

  if (
    !f.hasFutureFollowUp &&
    idleDays !== null &&
    idleDays > cfg.overdueAfterDays &&
    (ageDays ?? 0) < cfg.reactivationMinAgeDays
  )
    return {
      priority: 6,
      workflowKey: 'overdue_followup',
      agentKey: 'lead_recovery',
      segment: f.lastInboundAt ? 'overdue_engaged' : 'overdue_no_reply',
      evidence: [
        {
          rule: 'P6.overdue_no_future_followup',
          facts: {
            ...base,
            idleDays: Math.floor(idleDays),
            hasFutureFollowUp: false,
          },
        },
      ],
    };

  if (
    neverContacted &&
    ageDays !== null &&
    ageDays * 24 > cfg.newLeadWindowHours &&
    ageDays < cfg.reactivationMinAgeDays
  )
    return {
      priority: 6,
      workflowKey: 'overdue_followup',
      agentKey: 'lead_recovery',
      segment: 'never_contacted',
      evidence: [
        {
          rule: 'P6.never_contacted',
          facts: { createdInCrmAt: iso(f.createdInCrmAt) },
        },
      ],
    };

  if (
    ageDays !== null &&
    ageDays >= cfg.reactivationMinAgeDays &&
    ageDays <= cfg.reactivationMaxAgeDays &&
    !f.hasFutureFollowUp
  ) {
    const evidence: Evidence[] = [
      {
        rule: 'P7.older_lead_reactivation',
        facts: {
          ageDays: Math.floor(ageDays),
          leadSource: f.leadSource,
          engagedBefore: !!f.lastInboundAt,
        },
      },
    ];
    if (f.vehicleAvailableAgain === true)
      evidence.push({
        rule: 'P7.vehicle_available_again',
        facts: { verified: true },
      });
    return {
      priority: 7,
      workflowKey: 'recovery_reactivation',
      agentKey: 'lead_recovery',
      segment: f.vehicleAvailableAgain
        ? 'vehicle_available_again'
        : f.lastInboundAt
          ? 'older_engaged'
          : 'older_never_engaged',
      evidence,
    };
  }

  return null;
}

/** Outbound attempts since the customer's last inbound message. */
export function countUnanswered(
  messages: Array<{ direction: string; occurredAt: Date; channel: string }>,
): number {
  const sorted = [...messages]
    .filter((m) => m.channel !== 'NOTE')
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
  let n = 0;
  for (const m of sorted) {
    if (m.direction === 'INBOUND') break;
    n += 1;
  }
  return n;
}
