import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { pickRoundRobinAssignee } from '../leads/round-robin';
import { StoreHoursService } from '../locations/store-hours.service';
import { PrismaService } from '../prisma/prisma.service';
import { Actor } from './control.service';
import { Department } from './crm-workforce.types';
import { localMinutes } from './policy/compliance.engine';
import { auditSafe } from './vault.service';

type Scope = { tenantId: string; locationId: string | null };

export const WORK_ITEM_KINDS = [
  'APPOINTMENT_REQUEST',
  'APPOINTMENT_RESCHEDULE',
  'APPOINTMENT_CANCEL',
  'APPOINTMENT_CONFIRM',
  'CRM_NOTE',
  'FOLLOW_UP',
  'ESCALATION',
  'QUALIFIED_BUYER',
  'SERVICE_REQUEST',
  'PARTS_INQUIRY',
] as const;
export type WorkItemKind = (typeof WORK_ITEM_KINDS)[number];
export const APPOINTMENT_TYPES = [
  'SALES_VISIT',
  'TEST_DRIVE',
  'SERVICE',
  'PARTS_PICKUP',
] as const;
const OPEN = ['OPEN', 'IN_PROGRESS'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

const scrub = (s: string | undefined | null, max = 500) =>
  s ? (auditSafe({ t: s }) as { t: string }).t.slice(0, max) : null;

/**
 * Internal requests for a person to act in the CRM. The dealership's CRM stays the only place
 * an appointment, note or task really exists:
 *   OPEN            the workforce (or an employee) asked for it
 *   IN_PROGRESS     an employee picked it up
 *   STAFF_CONFIRMED an employee says it is done in the CRM (their statement, with a reference)
 *   CRM_VERIFIED    a connector re-read the CRM and found it (no connector can do this today)
 * An appointment request is never called booked or confirmed by this system.
 */
@Injectable()
export class CrmWfWorkItemService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hours: StoreHoursService,
  ) {}

  /** Idempotent on (tenant, dedupeKey). */
  async create(d: {
    tenantId: string;
    locationId: string;
    crmLeadId?: string | null;
    department: Department;
    kind: WorkItemKind;
    title: string;
    payload?: Record<string, unknown>;
    urgency?: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';
    dueAt?: Date | null;
    assigneeName?: string | null;
    createdBy: string;
    dedupeKey: string;
  }) {
    try {
      return await this.prisma.crmWfWorkItem.create({
        data: {
          tenantId: d.tenantId,
          locationId: d.locationId,
          crmLeadId: d.crmLeadId ?? null,
          department: d.department,
          kind: d.kind,
          title: d.title.slice(0, 200),
          payload: auditSafe(d.payload ?? {}) as Prisma.InputJsonValue,
          urgency: d.urgency ?? 'NORMAL',
          dueAt: d.dueAt ?? null,
          assigneeName: d.assigneeName ?? null,
          createdBy: d.createdBy,
          dedupeKey: d.dedupeKey,
        },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      )
        return this.prisma.crmWfWorkItem.findUniqueOrThrow({
          where: {
            tenantId_dedupeKey: {
              tenantId: d.tenantId,
              dedupeKey: d.dedupeKey,
            },
          },
        });
      throw e;
    }
  }

  private async lead(scope: Scope, id: string) {
    const lead = await this.prisma.crmWfLead.findFirst({
      where: {
        id,
        tenantId: scope.tenantId,
        ...(scope.locationId ? { locationId: scope.locationId } : {}),
      },
    });
    if (!lead) throw new NotFoundException('lead_not_found');
    return lead;
  }

  /**
   * Check a requested time against the rooftop's VERIFIED department hours.
   *   INSIDE_VERIFIED_HOURS   the department is open then
   *   OUTSIDE_VERIFIED_HOURS  it is closed then → the request is refused
   *   HOURS_NOT_VERIFIED      no verified hours on file → accepted, flagged for staff
   * This says nothing about whether a slot is free: nobody but the CRM/scheduler knows that.
   */
  async hoursCheck(
    tenantId: string,
    locationId: string,
    department: Department,
    at: Date,
  ) {
    const p = await this.hours.getProfile(tenantId, locationId);
    if (!p?.verified || p.synthetic) return 'HOURS_NOT_VERIFIED' as const;
    const dept = (
      { SALES: 'sales', SERVICE: 'service', PARTS: 'parts' } as const
    )[department];
    const weekly = (p.weekly[dept] ?? p.weekly.store) as
      | Record<string, { open: number; close: number } | null>
      | undefined;
    if (!weekly) return 'HOURS_NOT_VERIFIED' as const;
    const day = new Intl.DateTimeFormat('en-US', {
      timeZone: p.timezone,
      weekday: 'short',
    })
      .format(at)
      .toLowerCase()
      .slice(0, 3);
    const iso = new Intl.DateTimeFormat('en-CA', {
      timeZone: p.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at);
    const holiday = p.holidays.find((h) => h.date === iso && h.closed);
    const h = weekly[WEEKDAYS.find((w) => w === day) ?? day];
    const mins = localMinutes(at, p.timezone);
    if (holiday || !h || mins === null || mins < h.open || mins >= h.close)
      return 'OUTSIDE_VERIFIED_HOURS' as const;
    return 'INSIDE_VERIFIED_HOURS' as const;
  }

  async requestAppointment(
    createdBy: string,
    scope: Scope,
    leadId: string,
    p: {
      change: 'REQUEST' | 'RESCHEDULE' | 'CANCEL' | 'CONFIRM';
      type?: string;
      requestedAt?: string;
      note?: string;
    },
  ) {
    const lead = await this.lead(scope, leadId);
    const kind = (
      {
        REQUEST: 'APPOINTMENT_REQUEST',
        RESCHEDULE: 'APPOINTMENT_RESCHEDULE',
        CANCEL: 'APPOINTMENT_CANCEL',
        CONFIRM: 'APPOINTMENT_CONFIRM',
      } as const
    )[p.change];
    let at: Date | null = null;
    let hoursCheck: string | null = null;
    if (p.change === 'REQUEST' || p.change === 'RESCHEDULE') {
      at = p.requestedAt ? new Date(p.requestedAt) : null;
      if (!at || !Number.isFinite(at.getTime()))
        throw new BadRequestException('requested_time_required');
      if (at.getTime() < Date.now())
        throw new BadRequestException('requested_time_is_in_the_past');
      hoursCheck = await this.hoursCheck(
        lead.tenantId,
        lead.locationId,
        lead.department,
        at,
      );
      if (hoursCheck === 'OUTSIDE_VERIFIED_HOURS')
        throw new BadRequestException(
          'requested_time_is_outside_dealership_hours',
        );
    }
    const type = (APPOINTMENT_TYPES as readonly string[]).includes(p.type ?? '')
      ? p.type!
      : lead.department === 'SERVICE'
        ? 'SERVICE'
        : 'SALES_VISIT';
    const verb = {
      REQUEST: 'requested',
      RESCHEDULE: 'reschedule requested',
      CANCEL: 'cancellation requested',
      CONFIRM: 'confirmation needed',
    }[p.change];
    return this.create({
      tenantId: lead.tenantId,
      locationId: lead.locationId,
      crmLeadId: lead.id,
      department: lead.department,
      kind,
      title: `${type.replace(/_/g, ' ').toLowerCase()} ${verb}`,
      urgency: p.change === 'CANCEL' ? 'NORMAL' : 'HIGH',
      dueAt: at,
      assigneeName: lead.assignedTo,
      createdBy,
      payload: {
        appointmentType: type,
        requestedAt: at?.toISOString() ?? null,
        hoursCheck,
        availability: 'NOT_VERIFIED — an employee confirms the time in the CRM',
        crmAppointmentAt: lead.appointmentAt?.toISOString() ?? null,
        note: scrub(p.note),
      },
      dedupeKey: `${kind}:${lead.id}:${at?.toISOString() ?? lead.appointmentAt?.toISOString() ?? 'none'}`,
    });
  }

  async followUp(
    createdBy: string,
    scope: Scope,
    leadId: string,
    p: { dueAt: string; instruction: string },
  ) {
    const lead = await this.lead(scope, leadId);
    const due = new Date(p.dueAt);
    if (!Number.isFinite(due.getTime()))
      throw new BadRequestException('due_date_required');
    return this.create({
      tenantId: lead.tenantId,
      locationId: lead.locationId,
      crmLeadId: lead.id,
      department: lead.department,
      kind: 'FOLLOW_UP',
      title: 'Follow up with customer',
      dueAt: due,
      assigneeName: lead.assignedTo,
      createdBy,
      payload: {
        instruction: scrub(p.instruction),
        createInCrm: 'An employee adds this task in the CRM',
      },
      dedupeKey: `FOLLOW_UP:${lead.id}:${due.toISOString().slice(0, 13)}`,
    });
  }

  async crmNote(createdBy: string, scope: Scope, leadId: string, text: string) {
    const lead = await this.lead(scope, leadId);
    const body = scrub(text, 1000);
    if (!body) throw new BadRequestException('note_text_required');
    return this.create({
      tenantId: lead.tenantId,
      locationId: lead.locationId,
      crmLeadId: lead.id,
      department: lead.department,
      kind: 'CRM_NOTE',
      title: 'Add note to CRM record',
      assigneeName: lead.assignedTo,
      createdBy,
      payload: {
        note: body,
        addInCrm: 'An employee adds this note in the CRM',
      },
      dedupeKey: `CRM_NOTE:${lead.id}:${Buffer.from(body).toString('base64url').slice(0, 40)}:${new Date().toISOString().slice(0, 16)}`,
    });
  }

  /**
   * Assignment recommendation only — it never changes ownership.
   * An owner recorded in the CRM is always kept. Otherwise: the active staff member at this
   * rooftop with the fewest open leads (the platform's existing round-robin rule).
   */
  async recommendAssignee(
    tenantId: string,
    locationId: string,
    crmOwner: string | null,
  ) {
    if (crmOwner?.trim())
      return {
        action: 'KEEP_OWNER' as const,
        name: crmOwner.trim(),
        reason: 'The CRM already assigns this customer.',
      };
    const userId = await pickRoundRobinAssignee(
      this.prisma,
      tenantId,
      locationId,
    );
    if (!userId)
      return {
        action: 'NONE' as const,
        name: null,
        reason: 'No staff accounts are set up for this rooftop.',
      };
    const u = await this.prisma.user.findFirst({
      where: { id: userId, tenantId },
      select: { firstName: true, lastName: true },
    });
    return {
      action: 'SUGGEST' as const,
      userId,
      name: u ? `${u.firstName} ${u.lastName}`.trim() : null,
      reason: 'Fewest open leads at this rooftop.',
    };
  }

  async list(
    scope: Scope,
    q: {
      kind?: string[];
      status?: string[];
      crmLeadId?: string;
      take?: number;
    },
  ) {
    return this.prisma.crmWfWorkItem.findMany({
      where: {
        tenantId: scope.tenantId,
        ...(scope.locationId ? { locationId: scope.locationId } : {}),
        ...(q.kind?.length ? { kind: { in: q.kind } } : {}),
        status: { in: q.status?.length ? q.status : OPEN },
        ...(q.crmLeadId ? { crmLeadId: q.crmLeadId } : {}),
      },
      orderBy: [
        { dueAt: { sort: 'asc', nulls: 'last' } },
        { createdAt: 'asc' },
      ],
      take: Math.min(q.take ?? 100, 200),
    });
  }

  private async load(scope: Scope, id: string) {
    const item = await this.prisma.crmWfWorkItem.findFirst({
      where: {
        id,
        tenantId: scope.tenantId,
        ...(scope.locationId ? { locationId: scope.locationId } : {}),
      },
    });
    if (!item) throw new NotFoundException('work_item_not_found');
    return item;
  }

  async claim(actor: Actor, scope: Scope, id: string) {
    await this.load(scope, id);
    const r = await this.prisma.crmWfWorkItem.updateMany({
      where: { id, status: 'OPEN' },
      data: { status: 'IN_PROGRESS', assignedUserId: actor.userId },
    });
    if (r.count !== 1)
      throw new ConflictException('already_picked_up_or_closed');
    return this.prisma.crmWfWorkItem.findUniqueOrThrow({ where: { id } });
  }

  /** An employee closes the item with what they did in the CRM. */
  async resolve(
    actor: Actor,
    scope: Scope,
    id: string,
    p: {
      outcome: 'DONE' | 'DECLINED' | 'CANCELLED';
      crmReference?: string;
      note?: string;
    },
  ) {
    const item = await this.load(scope, id);
    if (!OPEN.includes(item.status))
      throw new ConflictException(`item_is_${item.status.toLowerCase()}`);
    const isAppt = item.kind.startsWith('APPOINTMENT_');
    if (
      p.outcome === 'DONE' &&
      isAppt &&
      item.kind !== 'APPOINTMENT_CANCEL' &&
      !p.crmReference?.trim()
    )
      // "I booked it" needs the CRM's own reference; otherwise it stays a request.
      throw new BadRequestException('crm_appointment_reference_required');
    if (
      p.outcome !== 'DONE' &&
      !['SUPER_ADMIN', 'ADMIN', 'MANAGER'].includes(actor.role) &&
      item.assignedUserId &&
      item.assignedUserId !== actor.userId
    )
      throw new ForbiddenException(
        'only_the_assignee_or_a_manager_can_close_this',
      );
    const status = p.outcome === 'DONE' ? 'STAFF_CONFIRMED' : p.outcome;
    const out = await this.prisma.$transaction(async (tx) => {
      const row = await tx.crmWfWorkItem.update({
        where: { id },
        data: {
          status,
          resolvedAt: new Date(),
          resolvedByUserId: actor.userId,
          resolution: {
            basis: 'staff_statement',
            crmReference: p.crmReference?.trim().slice(0, 120) ?? null,
            note: scrub(p.note),
          },
        },
      });
      if (
        status === 'STAFF_CONFIRMED' &&
        item.crmLeadId &&
        (item.kind === 'APPOINTMENT_REQUEST' ||
          item.kind === 'APPOINTMENT_RESCHEDULE')
      )
        await tx.crmWfOutcome.createMany({
          skipDuplicates: true,
          // Staff-stated and attributed to workforce activity; never "shown", never verified.
          data: [
            {
              tenantId: item.tenantId,
              locationId: item.locationId,
              crmLeadId: item.crmLeadId,
              department: item.department,
              kind: 'APPT_SET',
              basis: 'ATTRIBUTED',
              sourceRecordId: `workitem:${item.id}`,
              verified: false,
              occurredAt: new Date(),
            },
          ],
        });
      await tx.auditLog.create({
        data: {
          tenantId: item.tenantId,
          userId: actor.userId,
          action: 'crmwf.workitem.resolved',
          resource: 'CrmWfWorkItem',
          resourceId: id,
          metadata: auditSafe({
            kind: item.kind,
            status,
            hasCrmReference: !!p.crmReference,
          }),
        },
      });
      return row;
    });
    return out;
  }
}
