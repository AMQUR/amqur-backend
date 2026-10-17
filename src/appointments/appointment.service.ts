import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  Appointment,
  AppointmentStatus,
  AppointmentType,
  Prisma,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  Department,
  HoursProfile,
  StoreHoursService,
} from '../locations/store-hours.service';
import type { ResolvedWhen } from '../common/time/date-phrase';
import {
  addDays,
  formatClock,
  fromZoned,
  LocalDate,
  parseIsoDate,
  toZoned,
} from '../common/time/zoned-time';
import { SchedulingProviderRegistry } from './scheduling-provider.registry';
import type {
  SchedulingDepartment,
  SchedulingOutcome,
} from './scheduling-provider';
import { CircuitBreakerService } from '../integrations/core/circuit-breaker.service';
import { MetricsService } from '../observability/metrics.service';
import { CampaignEngine } from '../messaging/campaign.engine';

export type AppointmentRequestInput = {
  tenantId: string;
  locationId?: string | null;
  conversationId?: string | null;
  leadId?: string | null;
  type: AppointmentType;
  when: Pick<ResolvedWhen, 'date' | 'time' | 'partOfDay' | 'phrase'>;
  vin?: string | null;
  serviceType?: string | null;
  transportation?: string | null;
  customer?: {
    name?: string | null;
    phone?: string | null;
    email?: string | null;
  };
  notes?: string | null;
  idempotencyKey?: string;
  source: 'chat' | 'staff' | 'api';
  actorId?: string | null;
  now?: Date;
};

export type AppointmentRequestResult =
  | {
      status: 'saved';
      appointment: Appointment;
      /** requested = AMQUR request only; pending = provider accepted, awaiting confirmation; confirmed = provider-confirmed */
      outcome: 'requested' | 'pending' | 'confirmed';
      hoursVerified: boolean;
      providerFailure?: string;
    }
  | {
      status: 'rejected';
      code: 'closed_day' | 'outside_hours' | 'in_past' | 'unavailable';
      day?: {
        date: string;
        open: number | null;
        close: number | null;
        note?: string;
      };
      alternatives: Array<{ date: string; open: number; close: number }>;
      timezone: string;
    }
  | { status: 'incomplete'; missing: 'date' | 'time' };

const DURATION: Record<AppointmentType, number> = {
  SALES: 45,
  TEST_DRIVE: 45,
  FINANCE: 45,
  SERVICE: 60,
  PARTS: 30,
};

const PART_OF_DAY_DEFAULT_REQUIRED = true;

export function departmentFor(type: AppointmentType): Department {
  if (type === 'SERVICE') return 'service';
  if (type === 'PARTS') return 'parts';
  return 'sales';
}

/** Allowed transitions — anything else is a 409. */
const TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  REQUESTED: ['PENDING_CONFIRMATION', 'CONFIRMED', 'RESCHEDULED', 'CANCELLED'],
  PENDING_CONFIRMATION: ['CONFIRMED', 'RESCHEDULED', 'CANCELLED'],
  CONFIRMED: ['RESCHEDULED', 'CANCELLED', 'COMPLETED', 'NO_SHOW'],
  RESCHEDULED: [],
  CANCELLED: [],
  COMPLETED: [],
  NO_SHOW: [],
};

/** Statuses staff may set from ops queues — not repair-order / DMS provider fields. */
export const STAFF_APPOINTMENT_QUEUE_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.PENDING_CONFIRMATION,
  AppointmentStatus.CONFIRMED,
  AppointmentStatus.CANCELLED,
  AppointmentStatus.COMPLETED,
];

/**
 * First-class appointment lifecycle. Every sales/service/parts/finance/test-drive request
 * becomes a durable Appointment row BEFORE the assistant acknowledges it. Confirmation
 * only comes from an authoritative scheduler or an authorized staff action.
 */
@Injectable()
export class AppointmentService {
  private readonly logger = new Logger(AppointmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hours: StoreHoursService,
    private readonly registry: SchedulingProviderRegistry,
    private readonly breaker: CircuitBreakerService,
    private readonly metrics: MetricsService,
    @Optional() private readonly campaigns?: CampaignEngine,
  ) {}

  async getHours(
    tenantId: string,
    locationId?: string | null,
  ): Promise<HoursProfile | null> {
    return this.hours.getProfile(tenantId, locationId);
  }

  static nextOpenDays(
    profile: HoursProfile,
    from: LocalDate,
    dept: Department,
    count = 3,
  ): Array<{ date: string; open: number; close: number }> {
    const out: Array<{ date: string; open: number; close: number }> = [];
    for (let i = 0; i <= 21 && out.length < count; i += 1) {
      const d = StoreHoursService.resolveDay(profile, addDays(from, i), dept);
      if (!d.closed && d.open !== null && d.close !== null) {
        out.push({ date: d.date, open: d.open, close: d.close });
      }
    }
    return out;
  }

  async request(
    input: AppointmentRequestInput,
  ): Promise<AppointmentRequestResult> {
    const now = input.now ?? new Date();
    if (!input.when.date) return { status: 'incomplete', missing: 'date' };
    if (
      input.when.time === undefined &&
      !input.when.partOfDay &&
      PART_OF_DAY_DEFAULT_REQUIRED
    ) {
      return { status: 'incomplete', missing: 'time' };
    }
    const profile = await this.hours.getProfile(
      input.tenantId,
      input.locationId,
    );
    const tz = profile?.timezone ?? 'America/Chicago';
    const dept = departmentFor(input.type);
    const date = input.when.date;

    let requestedAt: Date | null = null;
    if (profile?.verified) {
      // Validate against authoritative hours. Part-of-day only checks the day is open.
      if (input.when.time !== undefined) {
        const v = StoreHoursService.validateSlot(
          profile,
          date,
          input.when.time,
          {
            department: dept,
            now,
          },
        );
        if (!v.ok) {
          if (v.code === 'hours_unverified' || v.code === 'invalid') {
            // fall through: treat as unverified request
          } else {
            return {
              status: 'rejected',
              code: v.code,
              day: v.day
                ? {
                    date: v.day.date,
                    open: v.day.open,
                    close: v.day.close,
                    note: v.day.note,
                  }
                : undefined,
              alternatives: AppointmentService.nextOpenDays(
                profile,
                v.code === 'outside_hours' ? date : addDays(date, 1),
                dept,
              ).filter((a) => v.code !== 'in_past' || a.date >= toIso(now, tz)),
              timezone: tz,
            };
          }
        } else {
          requestedAt = v.instant;
        }
      } else {
        const d = StoreHoursService.resolveDay(profile, date, dept);
        if (d.closed) {
          return {
            status: 'rejected',
            code: 'closed_day',
            day: { date: d.date, open: d.open, close: d.close, note: d.note },
            alternatives: AppointmentService.nextOpenDays(
              profile,
              addDays(date, 1),
              dept,
            ),
            timezone: tz,
          };
        }
      }
    } else if (input.when.time !== undefined) {
      // Hours unknown: still interpret in dealership tz; never claim the slot is open.
      requestedAt = fromZoned(
        {
          ...date,
          hour: Math.floor(input.when.time / 60),
          minute: input.when.time % 60,
        },
        tz,
      );
      if (requestedAt.getTime() <= now.getTime()) {
        return {
          status: 'rejected',
          code: 'in_past',
          alternatives: [],
          timezone: tz,
        };
      }
    }

    const idempotencyKey =
      input.idempotencyKey ??
      `appt:${input.conversationId ?? randomUUID()}:${input.type}:${isoOf(date)}:${input.when.time ?? input.when.partOfDay ?? ''}`;

    const existing = await this.prisma.appointment.findUnique({
      where: {
        tenantId_idempotencyKey: { tenantId: input.tenantId, idempotencyKey },
      },
    });
    if (
      existing &&
      existing.status !== 'CANCELLED' &&
      existing.status !== 'RESCHEDULED'
    ) {
      return {
        status: 'saved',
        appointment: existing,
        outcome:
          existing.status === 'CONFIRMED'
            ? 'confirmed'
            : existing.status === 'PENDING_CONFIRMATION'
              ? 'pending'
              : 'requested',
        hoursVerified: !!profile?.verified,
      };
    }

    const requestedTime =
      input.when.time !== undefined
        ? formatClock(input.when.time)
        : (input.when.partOfDay ?? null);

    // CRITICAL WRITE: row + outbox atomically, before any acknowledgement.
    const appointment = await this.prisma.$transaction(async (tx) => {
      const row = await tx.appointment.create({
        data: {
          tenantId: input.tenantId,
          locationId: input.locationId ?? null,
          conversationId: input.conversationId ?? null,
          leadId: input.leadId ?? null,
          type: input.type,
          requestedDate: isoOf(date),
          requestedTime,
          requestedPhrase: input.when.phrase?.slice(0, 120) ?? null,
          requestedAt,
          timezone: tz,
          status: AppointmentStatus.REQUESTED,
          availabilityVerified: false,
          provider: 'NONE',
          serviceType: input.serviceType ?? null,
          transportation: input.transportation ?? null,
          vehicleVin: input.vin?.toUpperCase() ?? null,
          customerName: input.customer?.name ?? null,
          customerPhone: input.customer?.phone ?? null,
          customerEmail: input.customer?.email ?? null,
          notes: input.notes?.slice(0, 1000) ?? null,
          idempotencyKey,
          provenance: {
            source: input.source,
            recordedBy: input.actorId ?? 'amqur',
            hoursVerified: !!profile?.verified,
            hoursVerifiedAt: profile?.verifiedAt ?? null,
          } as Prisma.InputJsonValue,
        },
      });
      await tx.outboxEvent.create({
        data: {
          tenantId: input.tenantId,
          topic: 'appointment.requested',
          idempotencyKey: `outbox:${idempotencyKey}`,
          payload: {
            appointmentId: row.id,
            tenantId: input.tenantId,
            locationId: input.locationId ?? null,
            type: input.type,
          } as Prisma.InputJsonValue,
        },
      });
      return row;
    });
    this.metrics.increment('appointments.requested');
    if (
      input.type === 'SERVICE' &&
      input.conversationId &&
      appointment.status === AppointmentStatus.REQUESTED
    ) {
      await this.notifyServiceAdvisor(appointment).catch(() => undefined);
    }

    // Authoritative scheduler (if one is explicitly enabled) — confirmation only from provider.
    let outcome: 'requested' | 'pending' | 'confirmed' = 'requested';
    let providerFailure: string | undefined;
    let final = appointment;
    if (requestedAt) {
      const scheduler = await this.registry.resolve(
        input.tenantId,
        input.locationId,
      );
      if (scheduler?.adapter.create) {
        const ctx = this.registry.context(
          scheduler,
          input.tenantId,
          input.locationId,
          idempotencyKey,
          appointment.id,
        );
        let res: SchedulingOutcome;
        try {
          res = await withTimeout(
            scheduler.adapter.create(ctx, {
              department: input.type as SchedulingDepartment,
              startUtc: requestedAt.toISOString(),
              durationMinutes: DURATION[input.type],
              customer: input.customer ?? {},
              vin: input.vin,
              serviceType: input.serviceType,
              notes: input.notes,
            }),
            ctx.timeoutMs,
          );
          this.breaker.recordSuccess(`scheduler:${scheduler.connectionId}`);
        } catch (e) {
          this.breaker.recordFailure(`scheduler:${scheduler.connectionId}`);
          res = {
            kind: 'failed',
            errorCode: e instanceof Error ? e.message.slice(0, 80) : 'error',
            retryable: true,
          };
        }
        final = await this.applyProviderOutcome(
          appointment,
          scheduler.provider,
          res,
        );
        if (res.kind === 'confirmed') {
          outcome = 'confirmed';
          await this.enrollAppointmentReminder(input.tenantId, final);
        } else if (res.kind === 'pending') outcome = 'pending';
        else if (res.kind === 'failed') providerFailure = res.errorCode;
        else if (res.kind === 'unavailable') {
          return {
            status: 'rejected',
            code: 'unavailable',
            alternatives: (res.alternatives ?? []).slice(0, 3).map((s) => {
              const z = toZoned(new Date(s.startUtc), tz);
              return {
                date: isoOf(z),
                open: z.hour * 60 + z.minute,
                close: z.hour * 60 + z.minute,
              };
            }),
            timezone: tz,
          };
        }
      }
    }

    return {
      status: 'saved',
      appointment: final,
      outcome,
      hoursVerified: !!profile?.verified,
      providerFailure,
    };
  }

  private async applyProviderOutcome(
    appt: Appointment,
    provider: string,
    res: SchedulingOutcome,
  ): Promise<Appointment> {
    const prov = { ...(appt.provenance as Record<string, unknown> | null) };
    switch (res.kind) {
      case 'confirmed':
        this.metrics.increment('appointments.provider_confirmed');
        return this.prisma.appointment.update({
          where: { id: appt.id },
          data: {
            status: AppointmentStatus.CONFIRMED,
            availabilityVerified: true,
            provider,
            externalProviderId: res.externalId,
            providerStatus: res.providerStatus,
            scheduledAt: new Date(res.scheduledAtUtc),
            confirmedAt: new Date(),
            provenance: {
              ...prov,
              confirmedBy: provider,
              providerRequestId: res.providerRequestId ?? null,
            },
          },
        });
      case 'pending':
        return this.prisma.appointment.update({
          where: { id: appt.id },
          data: {
            status: AppointmentStatus.PENDING_CONFIRMATION,
            provider,
            externalProviderId: res.externalId ?? null,
            providerStatus: res.providerStatus,
            provenance: {
              ...prov,
              providerRequestId: res.providerRequestId ?? null,
            },
          },
        });
      case 'unavailable':
        return this.prisma.appointment.update({
          where: { id: appt.id },
          data: {
            status: AppointmentStatus.CANCELLED,
            canceledAt: new Date(),
            cancelReason: `provider_unavailable:${res.reason}`.slice(0, 200),
            provider,
          },
        });
      case 'failed':
        this.metrics.increment('appointments.provider_failed');
        return this.prisma.appointment.update({
          where: { id: appt.id },
          data: {
            provider,
            providerStatus: `FAILED:${res.errorCode}`.slice(0, 120),
          },
        });
    }
  }

  /** Customer- or staff-initiated reschedule. Old row → RESCHEDULED, new row linked. */
  async reschedule(params: {
    tenantId: string;
    appointmentId: string;
    when: Pick<ResolvedWhen, 'date' | 'time' | 'partOfDay' | 'phrase'>;
    source: 'chat' | 'staff' | 'api';
    actorId?: string | null;
    now?: Date;
  }): Promise<AppointmentRequestResult> {
    const old = await this.prisma.appointment.findFirst({
      where: { id: params.appointmentId, tenantId: params.tenantId },
    });
    if (!old) throw new NotFoundException('Appointment not found');
    if (!TRANSITIONS[old.status].includes(AppointmentStatus.RESCHEDULED)) {
      throw new ConflictException(`Cannot reschedule from ${old.status}`);
    }
    const res = await this.request({
      tenantId: old.tenantId,
      locationId: old.locationId,
      conversationId: old.conversationId,
      leadId: old.leadId,
      type: old.type,
      when: params.when,
      vin: old.vehicleVin,
      serviceType: old.serviceType,
      transportation: old.transportation,
      customer: {
        name: old.customerName,
        phone: old.customerPhone,
        email: old.customerEmail,
      },
      notes: old.notes,
      idempotencyKey: `${old.idempotencyKey ?? old.id}:r:${isoOf(params.when.date ?? { year: 0, month: 0, day: 0 })}:${params.when.time ?? params.when.partOfDay ?? ''}`,
      source: params.source,
      actorId: params.actorId,
      now: params.now,
    });
    if (res.status !== 'saved') return res;
    await this.prisma.$transaction([
      this.prisma.appointment.update({
        where: { id: old.id },
        data: { status: AppointmentStatus.RESCHEDULED },
      }),
      this.prisma.appointment.update({
        where: { id: res.appointment.id },
        data: { rescheduledFromId: old.id },
      }),
    ]);
    if (old.externalProviderId && old.provider !== 'NONE') {
      // Provider-owned booking: ask the provider to cancel the old slot; record state honestly.
      await this.enqueueProviderOp(old, 'appointment.provider.cancel');
    }
    this.metrics.increment('appointments.rescheduled');
    return {
      ...res,
      appointment: { ...res.appointment, rescheduledFromId: old.id },
    };
  }

  async cancel(params: {
    tenantId: string;
    appointmentId: string;
    reason?: string;
    source: 'chat' | 'staff' | 'api';
    actorId?: string | null;
  }): Promise<Appointment> {
    const appt = await this.prisma.appointment.findFirst({
      where: { id: params.appointmentId, tenantId: params.tenantId },
    });
    if (!appt) throw new NotFoundException('Appointment not found');
    if (!TRANSITIONS[appt.status].includes(AppointmentStatus.CANCELLED)) {
      throw new ConflictException(`Cannot cancel from ${appt.status}`);
    }
    const updated = await this.prisma.appointment.update({
      where: { id: appt.id },
      data: {
        status: AppointmentStatus.CANCELLED,
        canceledAt: new Date(),
        cancelReason: params.reason?.slice(0, 200) ?? params.source,
      },
    });
    if (appt.externalProviderId && appt.provider !== 'NONE') {
      await this.enqueueProviderOp(appt, 'appointment.provider.cancel');
    }
    this.metrics.increment('appointments.canceled');
    return updated;
  }

  /** Schedules appointment reminder campaign when a slot is confirmed with a time. */
  private async enrollAppointmentReminder(
    tenantId: string,
    appt: Pick<Appointment, 'id' | 'locationId' | 'scheduledAt'>,
  ) {
    if (!appt.scheduledAt) return;
    await this.campaigns?.onEvent({
      tenantId,
      locationId: appt.locationId,
      trigger: 'appointment.confirmed.reminder',
      subjectId: appt.id,
      scheduledAt: appt.scheduledAt,
    });
  }

  /** Staff confirmation (human verified the slot by phone/DMS) — recorded with actor. */
  async staffTransition(params: {
    tenantId: string;
    appointmentId: string;
    to: AppointmentStatus;
    actorId: string;
    scheduledAt?: string;
    note?: string;
  }): Promise<Appointment> {
    const appt = await this.prisma.appointment.findFirst({
      where: { id: params.appointmentId, tenantId: params.tenantId },
    });
    if (!appt) throw new NotFoundException('Appointment not found');
    if (params.to === 'RESCHEDULED') {
      throw new BadRequestException('Use the reschedule endpoint');
    }
    if (!TRANSITIONS[appt.status].includes(params.to)) {
      throw new ConflictException(`Cannot move ${appt.status} → ${params.to}`);
    }
    const prov = { ...(appt.provenance as Record<string, unknown> | null) };
    const data: Prisma.AppointmentUpdateInput = { status: params.to };
    if (params.to === 'CONFIRMED') {
      const scheduledAt = params.scheduledAt
        ? new Date(params.scheduledAt)
        : appt.requestedAt;
      if (!scheduledAt || Number.isNaN(scheduledAt.getTime())) {
        throw new BadRequestException('scheduledAt required to confirm');
      }
      data.scheduledAt = scheduledAt;
      data.confirmedAt = new Date();
      data.availabilityVerified = true;
      data.provenance = {
        ...prov,
        confirmedBy: `staff:${params.actorId}`,
        confirmNote: params.note ?? null,
      };
    }
    if (params.to === 'CANCELLED') {
      data.canceledAt = new Date();
      data.cancelReason = params.note?.slice(0, 200) ?? 'staff';
    }
    if (params.to === 'COMPLETED') data.completedAt = new Date();
    const updated = await this.prisma.appointment.update({
      where: { id: appt.id },
      data,
    });
    if (params.to === 'CONFIRMED') {
      await this.enrollAppointmentReminder(params.tenantId, updated);
    }
    if (params.to === 'NO_SHOW') {
      await this.campaigns?.onEvent({
        tenantId: params.tenantId,
        locationId: updated.locationId,
        trigger: 'appointment.no_show',
        subjectId: updated.id,
      });
    }
    if (params.to === 'COMPLETED' || params.to === 'NO_SHOW') {
      await this.prisma.analyticsEvent
        .create({
          data: {
            tenantId: params.tenantId,
            locationId: updated.locationId,
            eventType:
              params.to === 'COMPLETED'
                ? 'appointment.completed'
                : 'appointment.no_show',
            properties: {
              appointmentId: updated.id,
              type: updated.type,
              from: appt.status,
              actorId: params.actorId,
            },
          },
        })
        .catch(() => undefined);
    }
    if (params.to === 'COMPLETED' && appt.type === 'SERVICE') {
      // Internal SERVICE CSI draft for staff follow-up — never auto-SMS, not OEM CSI.
      await this.prisma.customerSurvey
        .create({
          data: {
            tenantId: params.tenantId,
            locationId: updated.locationId,
            leadId: appt.leadId,
            conversationId: appt.conversationId,
            appointmentId: updated.id,
            kind: 'SERVICE',
            channel: 'IN_PERSON',
            status: 'DRAFT',
            metadata: {
              trigger: 'service_appointment_completed',
              appointmentId: updated.id,
              note: 'Staff-recorded CSI draft — not an OEM manufacturer survey',
            },
          },
        })
        .catch(() => null);
    }
    await this.prisma.auditLog
      .create({
        data: {
          tenantId: params.tenantId,
          userId: params.actorId,
          action: `appointment.${params.to.toLowerCase()}`,
          resource: 'Appointment',
          resourceId: appt.id,
          metadata: { from: appt.status, to: params.to },
        },
      })
      .catch(() => undefined);
    return updated;
  }

  /**
   * Staff workflow update from ops queues — notes + lifecycle status only.
   * Never writes providerStatus or invented repair-order state.
   */
  async updateStaff(
    tenantId: string,
    locationId: string | null | undefined,
    appointmentId: string,
    userId: string,
    patch: {
      status?: AppointmentStatus;
      notes?: string | null;
      scheduledAt?: string;
      acknowledgeEscalation?: boolean;
    },
  ): Promise<Appointment> {
    const row = await this.prisma.appointment.findFirst({
      where: {
        id: appointmentId,
        tenantId,
        ...(locationId ? { locationId } : {}),
      },
    });
    if (!row) throw new NotFoundException('Appointment not found');

    let updated = row;
    const notesChanged = patch.notes !== undefined;
    if (notesChanged) {
      const trimmed = patch.notes?.trim() ?? '';
      updated = await this.prisma.appointment.update({
        where: { id: row.id },
        data: { notes: trimmed.length ? trimmed.slice(0, 4000) : null },
      });
    }

    if (patch.status !== undefined && patch.status !== row.status) {
      if (!STAFF_APPOINTMENT_QUEUE_STATUSES.includes(patch.status)) {
        throw new BadRequestException('Invalid status');
      }
      updated = await this.staffTransition({
        tenantId,
        appointmentId: row.id,
        to: patch.status,
        actorId: userId,
        scheduledAt: patch.scheduledAt,
        note:
          patch.status === AppointmentStatus.CANCELLED
            ? (patch.notes?.trim().slice(0, 200) ?? 'staff')
            : undefined,
      });
    }

    if (patch.acknowledgeEscalation && row.conversationId) {
      const open = await this.prisma.escalation.findMany({
        where: {
          tenantId,
          conversationId: row.conversationId,
          reason: 'SERVICE_ADVISOR',
          status: 'OPEN',
        },
      });
      const match = open.filter((e) => {
        const meta = e.metadata as { appointmentId?: string } | null;
        return !meta?.appointmentId || meta.appointmentId === row.id;
      });
      if (match.length) {
        await this.prisma.escalation.updateMany({
          where: { id: { in: match.map((e) => e.id) } },
          data: { status: 'ACKNOWLEDGED' },
        });
      }
    }

    if (
      notesChanged ||
      (patch.status !== undefined && patch.status !== row.status) ||
      patch.acknowledgeEscalation
    ) {
      await this.prisma.auditLog
        .create({
          data: {
            tenantId,
            userId,
            action: 'appointment_request.update',
            resource: 'Appointment',
            resourceId: row.id,
            metadata: {
              status: patch.status ?? row.status,
              notesUpdated: notesChanged,
              escalationAcknowledged: !!patch.acknowledgeEscalation,
              type: row.type,
            },
          },
        })
        .catch(() => undefined);
    }

    return updated;
  }

  /**
   * Queue a service advisor escalation when a service appointment is captured.
   * Never claims the slot is confirmed — staff must verify with the customer/DMS.
   */
  private async notifyServiceAdvisor(
    row: Pick<
      Appointment,
      | 'id'
      | 'tenantId'
      | 'locationId'
      | 'conversationId'
      | 'type'
      | 'requestedDate'
      | 'requestedTime'
      | 'serviceType'
      | 'status'
    >,
  ) {
    if (row.type !== 'SERVICE' || !row.conversationId) return;
    if (row.status === 'CONFIRMED' || row.status === 'CANCELLED') return;
    const open = await this.prisma.escalation.findFirst({
      where: {
        tenantId: row.tenantId,
        conversationId: row.conversationId,
        status: { in: ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS'] },
        reason: 'SERVICE_ADVISOR',
      },
    });
    if (open) return;
    const when = [row.requestedDate, row.requestedTime].filter(Boolean).join(' ');
    const need = row.serviceType ? ` · ${row.serviceType}` : '';
    await this.prisma.escalation.create({
      data: {
        tenantId: row.tenantId,
        locationId: row.locationId,
        conversationId: row.conversationId,
        reason: 'SERVICE_ADVISOR',
        urgency: 'NORMAL',
        summary: `Service appointment request needs confirmation${need}${when ? ` · ${when}` : ''}`.slice(
          0,
          280,
        ),
        metadata: {
          appointmentId: row.id,
          availabilityVerified: false,
        },
      },
    });
    await this.prisma.analyticsEvent
      .create({
        data: {
          tenantId: row.tenantId,
          locationId: row.locationId,
          eventType: 'service.advisor_queued',
          properties: { appointmentId: row.id },
        },
      })
      .catch(() => null);
  }

  async list(
    tenantId: string,
    opts: {
      locationId?: string | null;
      status?: AppointmentStatus;
      from?: Date;
      to?: Date;
      take?: number;
      cursor?: string;
    },
  ) {
    return this.prisma.appointment.findMany({
      where: {
        tenantId,
        ...(opts.locationId ? { locationId: opts.locationId } : {}),
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.from || opts.to
          ? {
              OR: [
                { requestedAt: { gte: opts.from, lte: opts.to } },
                { scheduledAt: { gte: opts.from, lte: opts.to } },
              ],
            }
          : {}),
      },
      orderBy: [{ requestedAt: 'asc' }, { createdAt: 'desc' }],
      take: Math.min(opts.take ?? 50, 200),
      ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
    });
  }

  async activeForConversation(tenantId: string, conversationId: string) {
    return this.prisma.appointment.findFirst({
      where: {
        tenantId,
        conversationId,
        status: { in: ['REQUESTED', 'PENDING_CONFIRMATION', 'CONFIRMED'] },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async enqueueProviderOp(appt: Appointment, topic: string) {
    await this.prisma.outboxEvent
      .create({
        data: {
          tenantId: appt.tenantId,
          topic,
          idempotencyKey: `${topic}:${appt.id}`,
          payload: {
            appointmentId: appt.id,
            provider: appt.provider,
            externalProviderId: appt.externalProviderId,
          },
        },
      })
      .catch((e: unknown) => {
        if (
          !(
            e instanceof Prisma.PrismaClientKnownRequestError &&
            e.code === 'P2002'
          )
        )
          throw e;
      });
  }
}

function isoOf(d: { year: number; month: number; day: number }): string {
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

function toIso(now: Date, tz: string): string {
  const z = toZoned(now, tz);
  return isoOf(z);
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, rej) => {
        t = setTimeout(() => rej(new Error('provider_timeout')), ms);
      }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
}

export { parseIsoDate };
