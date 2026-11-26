import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_PRIORITY_CONFIG } from './intelligence/prioritization';
import { CrmWfVaultService } from './vault.service';

type Scope = { tenantId: string; locationId: string | null };
const DAY = 86_400_000;
/** Age cohorts in days: a lead is in cohort N when its age is in [N, next N). */
export const AGE_COHORTS = [7, 14, 30, 60, 90, 120, 180, 365] as const;
const CLOSED = DEFAULT_PRIORITY_CONFIG.closedStatuses;
const LOST = ['lost', 'dead', 'bad'];

export type MiningQueue = {
  id: string;
  label: string;
  group: 'Now' | 'Follow-up' | 'Recovery' | 'Departments';
  why: string;
  action: string;
};

export const MINING_QUEUES: MiningQueue[] = [
  {
    id: 'unanswered_inbound',
    group: 'Now',
    label: 'Unanswered customer messages',
    why: 'The customer wrote last and nobody has replied.',
    action: 'Reply now',
  },
  {
    id: 'new_uncontacted',
    group: 'Now',
    label: 'New leads, not contacted',
    why: 'No contact in either direction is recorded.',
    action: 'First response',
  },
  {
    id: 'unconfirmed_appointments',
    group: 'Now',
    label: 'Appointments to confirm',
    why: 'An appointment is scheduled within the next two days.',
    action: 'Confirm the appointment',
  },
  {
    id: 'missed_appointments',
    group: 'Follow-up',
    label: 'Missed appointments',
    why: 'The CRM marks the appointment as missed.',
    action: 'Offer a new time',
  },
  {
    id: 'visited_unsold',
    group: 'Follow-up',
    label: 'Visited, not sold',
    why: 'A showroom visit is recorded and the lead is still open.',
    action: 'Post-visit follow-up',
  },
  {
    id: 'no_followup',
    group: 'Follow-up',
    label: 'No follow-up scheduled',
    why: 'Contact has happened but no future task exists in the CRM.',
    action: 'Set the next step',
  },
  {
    id: 'went_cold',
    group: 'Follow-up',
    label: 'Engaged, then went quiet',
    why: 'The customer replied before and has not answered the last contact for a week or more.',
    action: 'One respectful check-in',
  },
  {
    id: 'lost',
    group: 'Recovery',
    label: 'Lost opportunities',
    why: 'The CRM status is lost. A manager decides whether any are worth revisiting.',
    action: 'Manager review',
  },
  ...AGE_COHORTS.map((n, i) => ({
    id: `age_${n}`,
    group: 'Recovery' as const,
    label: `${n}${AGE_COHORTS[i + 1] ? `–${AGE_COHORTS[i + 1] - 1}` : '+'} days old`,
    why: `Open lead created ${n}${AGE_COHORTS[i + 1] ? ` to ${AGE_COHORTS[i + 1] - 1}` : ' or more'} days ago.`,
    action: n >= 30 ? 'Reactivation, only with consent on record' : 'Follow-up',
  })),
  {
    id: 'service',
    group: 'Departments',
    label: 'Service opportunities',
    why: 'Open service inquiries.',
    action: 'Service advisor follow-up',
  },
  {
    id: 'parts',
    group: 'Departments',
    label: 'Outstanding parts inquiries',
    why: 'Open parts inquiries.',
    action: 'Parts counter callback',
  },
];

export type Eligibility = {
  /** ELIGIBLE means "nothing on record forbids contact" — never "permission to contact". */
  status:
    | 'ELIGIBLE'
    | 'NEEDS_CONSENT_REVIEW'
    | 'SUPPRESSED'
    | 'DO_NOT_CONTACT'
    | 'PAUSED'
    | 'DUPLICATE'
    | 'NO_CONTACT_DETAILS';
  reason: string;
};

/**
 * The data-mining department: deterministic work queues over the CRM mirror. No model is
 * involved and nothing is contacted from here. Every row says why it was selected, when the
 * customer was last engaged, who owns it, the recommended action, and whether anything on
 * record forbids contact. An old lead is never eligible merely because it exists: without a
 * consent record it is "needs consent review".
 */
@Injectable()
export class CrmWfMiningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vault: CrmWfVaultService,
  ) {}

  private where(
    scope: Scope,
    queue: string,
    now: Date,
  ): Prisma.CrmWfLeadWhereInput {
    const base: Prisma.CrmWfLeadWhereInput = {
      tenantId: scope.tenantId,
      ...(scope.locationId ? { locationId: scope.locationId } : {}),
    };
    const notClosed: Prisma.CrmWfLeadWhereInput = {
      NOT: { crmStatus: { in: CLOSED, mode: 'insensitive' } },
    };
    const ago = (d: number) => new Date(now.getTime() - d * DAY);
    const age = /^age_(\d+)$/.exec(queue);
    if (age) {
      const n = Number(age[1]);
      const i = AGE_COHORTS.indexOf(n as (typeof AGE_COHORTS)[number]);
      if (i < 0) throw new BadRequestException('unknown_queue');
      const next = AGE_COHORTS[i + 1];
      return {
        ...base,
        ...notClosed,
        createdInCrmAt: { lte: ago(n), ...(next ? { gt: ago(next) } : {}) },
      };
    }
    switch (queue) {
      // "Customer wrote last" compares two columns; narrowed precisely in `rows`.
      case 'unanswered_inbound':
        return { ...base, lastInboundAt: { not: null } };
      case 'new_uncontacted':
        return {
          ...base,
          ...notClosed,
          lastInboundAt: null,
          lastOutboundAt: null,
        };
      case 'unconfirmed_appointments':
        return {
          ...base,
          appointmentState: 'SCHEDULED',
          appointmentAt: { gte: now, lte: new Date(now.getTime() + 2 * DAY) },
        };
      case 'missed_appointments':
        return { ...base, ...notClosed, appointmentState: 'MISSED' };
      case 'visited_unsold':
        return { ...base, ...notClosed, visitedAt: { not: null } };
      case 'no_followup':
        return {
          ...base,
          ...notClosed,
          hasFutureFollowUp: false,
          OR: [
            { lastInboundAt: { not: null } },
            { lastOutboundAt: { not: null } },
          ],
        };
      case 'went_cold':
        return {
          ...base,
          ...notClosed,
          lastInboundAt: { not: null, lt: ago(7) },
          lastOutboundAt: { not: null },
        };
      case 'lost':
        return {
          ...base,
          crmStatus: { in: LOST, mode: 'insensitive' },
          createdInCrmAt: { gte: ago(365) },
        };
      case 'service':
        return { ...base, ...notClosed, department: 'SERVICE' };
      case 'parts':
        return { ...base, ...notClosed, department: 'PARTS' };
      default:
        throw new BadRequestException('unknown_queue');
    }
  }

  private keep(
    queue: string,
    l: { lastInboundAt: Date | null; lastOutboundAt: Date | null },
  ) {
    if (queue === 'unanswered_inbound')
      return (
        !!l.lastInboundAt &&
        (!l.lastOutboundAt || l.lastInboundAt > l.lastOutboundAt)
      );
    if (queue === 'went_cold')
      return (
        !!l.lastInboundAt &&
        !!l.lastOutboundAt &&
        l.lastOutboundAt > l.lastInboundAt
      );
    return true;
  }

  /** Queue list with counts. `went_cold` / `unanswered_inbound` are counted exactly. */
  async summary(scope: Scope, now = new Date()) {
    return Promise.all(
      MINING_QUEUES.map(async (q) => {
        const where = this.where(scope, q.id, now);
        let count: number;
        if (q.id === 'unanswered_inbound' || q.id === 'went_cold') {
          const rows = await this.prisma.crmWfLead.findMany({
            where,
            select: { lastInboundAt: true, lastOutboundAt: true },
            take: 5000,
          });
          count = rows.filter((r) => this.keep(q.id, r)).length;
        } else count = await this.prisma.crmWfLead.count({ where });
        return { ...q, count };
      }),
    );
  }

  async rows(scope: Scope, queue: string, now = new Date(), take = 100) {
    const def = MINING_QUEUES.find((q) => q.id === queue);
    if (!def) throw new BadRequestException('unknown_queue');
    const found = await this.prisma.crmWfLead.findMany({
      where: this.where(scope, queue, now),
      orderBy: [
        { lastInboundAt: { sort: 'desc', nulls: 'last' } },
        { createdInCrmAt: 'desc' },
      ],
      take:
        Math.min(take, 200) *
        (queue === 'unanswered_inbound' || queue === 'went_cold' ? 4 : 1),
    });
    const leads = found
      .filter((l) => this.keep(queue, l))
      .slice(0, Math.min(take, 200));

    // Eligibility for the whole page in three queries (suppression, consent, open work).
    const hashes = leads
      .flatMap((l) => [l.phoneHash, l.emailHash])
      .filter((h): h is string => !!h);
    const opened = leads.map((l) => this.vault.lead(l));
    const endpoints = opened
      .flatMap((l) => [l.phone, l.email])
      .filter((e): e is string => !!e);
    const suppressed = hashes.length
      ? await this.prisma.crmWfSuppression.findMany({
          where: {
            tenantId: scope.tenantId,
            endpointHash: { in: hashes },
            liftedAt: null,
          },
          select: { endpointHash: true, reason: true, channel: true },
        })
      : [];
    const consent = endpoints.length
      ? await this.prisma.consentRecord.findMany({
          where: {
            tenantId: scope.tenantId,
            endpoint: { in: endpoints },
            revokedAt: null,
          },
          select: { endpoint: true, granted: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        })
      : [];
    const open = await this.prisma.crmWfTask.findMany({
      where: {
        tenantId: scope.tenantId,
        crmLeadId: { in: leads.map((l) => l.id) },
        status: {
          in: [
            'PENDING',
            'CLAIMED',
            'AWAITING_APPROVAL',
            'ESCALATED',
            'BLOCKED',
          ],
        },
      },
      select: {
        crmLeadId: true,
        status: true,
        statusReason: true,
        workflowKey: true,
      },
    });
    const supBy = new Map(suppressed.map((s) => [s.endpointHash, s]));
    const latestConsent = new Map<string, boolean>();
    for (const c of consent)
      if (!latestConsent.has(c.endpoint))
        latestConsent.set(c.endpoint, c.granted);

    return {
      queue: def,
      asOf: now,
      rows: leads.map((l, i) => {
        const o = opened[i];
        const sup = [l.phoneHash, l.emailHash]
          .map((h) => (h ? supBy.get(h) : undefined))
          .find(Boolean);
        const granted = [o.phone, o.email].some(
          (e) => e && latestConsent.get(e) === true,
        );
        const eligibility: Eligibility = sup
          ? {
              status: 'SUPPRESSED',
              reason: `Customer opted out (${sup.reason.toLowerCase().replace(/_/g, ' ')})`,
            }
          : l.crmDoNotContact
            ? {
                status: 'DO_NOT_CONTACT',
                reason: 'CRM marks this customer do-not-contact',
              }
            : l.agentPaused
              ? {
                  status: 'PAUSED',
                  reason: l.pausedReason
                    ? `Paused: ${l.pausedReason.replace(/_/g, ' ')}`
                    : 'Paused for the virtual team',
                }
              : l.duplicateOfId
                ? {
                    status: 'DUPLICATE',
                    reason:
                      'Same contact as another lead at this rooftop; worked through that lead',
                  }
                : !o.phone && !o.email
                  ? {
                      status: 'NO_CONTACT_DETAILS',
                      reason: 'No phone or email on the record',
                    }
                  : queue === 'unanswered_inbound' || granted
                    ? {
                        status: 'ELIGIBLE',
                        reason: granted
                          ? 'Consent on record; final checks run before any send'
                          : 'Customer is waiting on a reply',
                      }
                    : {
                        status: 'NEEDS_CONSENT_REVIEW',
                        reason:
                          'No consent on record. An old lead is not permission to contact.',
                      };
        const last =
          [l.lastInboundAt, l.lastOutboundAt]
            .filter((d): d is Date => !!d)
            .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
        const work = open.find((t) => t.crmLeadId === l.id);
        return {
          id: l.id,
          crmRecordId: l.sourceRecordId,
          firstName: l.firstName,
          lastInitial: o.lastName ? `${o.lastName.slice(0, 1)}.` : null,
          phoneLast4: l.phoneLast4,
          department: l.department,
          salesperson: l.assignedTo,
          leadSource: l.leadSource,
          crmStatus: l.crmStatus,
          vehicleInterest: l.vehicleInterest,
          ageDays: l.createdInCrmAt
            ? Math.floor((now.getTime() - l.createdInCrmAt.getTime()) / DAY)
            : null,
          lastEngagementAt: last,
          lastEngagementBy:
            last &&
            l.lastInboundAt &&
            last.getTime() === l.lastInboundAt.getTime()
              ? 'customer'
              : last
                ? 'dealership'
                : null,
          reason: def.why,
          recommendedAction:
            eligibility.status === 'ELIGIBLE'
              ? def.action
              : eligibility.status === 'NEEDS_CONSENT_REVIEW'
                ? 'Review consent before any outreach'
                : 'No outreach',
          eligibility,
          openWork: work
            ? {
                status: work.status,
                reason: work.statusReason,
                workflow: work.workflowKey,
              }
            : null,
          dataAsOf: l.asOf,
          synthetic: l.synthetic,
        };
      }),
    };
  }
}
