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
import {
  isSandboxBooking,
  ResolvedScheduler,
  SchedulingProviderRegistry,
} from './scheduling-provider.registry';
import type {
  AvailabilitySlot,
  SchedulingContext,
  SchedulingDepartment,
  SchedulingOutcome,
} from './scheduling-provider';
import { CircuitBreakerService } from '../integrations/core/circuit-breaker.service';
import { MetricsService } from '../observability/metrics.service';
import { CampaignEngine } from '../messaging/campaign.engine';
import { LeadAppointmentUpdateService } from '../integrations/adf/lead-appointment-update.service';

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
  /**
   * A slot the scheduling provider itself offered (picked from an appointment picker). The
   * provider is authoritative for it, so store-hours validation is skipped and the booking
   * is attempted for exactly this start.
   */
  providerSlot?: { startUtc: string; providerSlotId?: string };
  source: 'chat' | 'staff' | 'api';
  actorId?: string | null;
  now?: Date;
};

/** Provider confirmation details — present only when backed by a CONFIRMED provider receipt. */
export type ProviderConfirmation = {
  ref: string | null;
  name: string;
  sandbox: boolean;
  startsAt: string | null;
};

export type AppointmentRequestResult =
  | {
      status: 'saved';
      appointment: Appointment;
      /** requested = AMQUR request only; pending = provider accepted, awaiting confirmation; confirmed = provider-confirmed */
      outcome: 'requested' | 'pending' | 'confirmed';
      hoursVerified: boolean;
      providerFailure?: string;
      provider?: ProviderConfirmation;
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

/** Outbox topic of the cancel-or-reconcile compensation job for an UNKNOWN booking outcome. */
export const APPOINTMENT_RECONCILE_TOPIC = 'appointment.provider.reconcile';

export class ProviderTimeoutError extends Error {
  constructor() {
    super('provider_timeout');
  }
}

/**
 * A short, PII-free code for an adapter exception. The exception TEXT is never stored: a vendor
 * error can echo a name, phone or email back.
 */
export function providerErrorCode(e: unknown): string {
  if (e instanceof ProviderTimeoutError) return 'provider_timeout';
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Za-z0-9_]{2,40}$/.test(code))
    return `provider_error_${code.toLowerCase()}`;
  if (typeof code === 'number' && Number.isInteger(code))
    return `provider_error_${code}`;
  return 'provider_error';
}

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
    @Optional() private readonly leadUpdates?: LeadAppointmentUpdateService,
  ) {}

  /**
   * R8: an appointment is a separate event from its lead. After a state change, let the lead's
   * route record (and, where the destination supports it, send) ONE update for that state. It
   * is idempotent and can never fail or delay the appointment flow itself.
   */
  private async reportToLead(
    appt: Pick<Appointment, 'id' | 'tenantId' | 'leadId'> | null | undefined,
  ): Promise<void> {
    if (!appt?.leadId || !this.leadUpdates) return;
    try {
      await this.leadUpdates.syncAppointment(appt.tenantId, appt.id);
    } catch {
      this.metrics.increment('adf.appointment_update.sync_error');
    }
  }

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
    if (input.providerSlot) {
      requestedAt = new Date(input.providerSlot.startUtc);
      if (
        Number.isNaN(requestedAt.getTime()) ||
        requestedAt.getTime() <= now.getTime()
      ) {
        return {
          status: 'rejected',
          code: 'in_past',
          alternatives: [],
          timezone: tz,
        };
      }
    } else if (profile?.verified) {
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

    let idempotencyKey =
      input.idempotencyKey ??
      `appt:${input.conversationId ?? randomUUID()}:${input.type}:${isoOf(date)}:${input.when.time ?? input.when.partOfDay ?? ''}`;

    // The same request after a cancelled/rescheduled one is a NEW attempt: it needs its own
    // key (the old row keeps the original), otherwise the insert below collides.
    for (let hop = 0; hop < 8; hop += 1) {
      const existing = await this.prisma.appointment.findUnique({
        where: {
          tenantId_idempotencyKey: { tenantId: input.tenantId, idempotencyKey },
        },
      });
      if (!existing) break;
      if (existing.status !== 'CANCELLED' && existing.status !== 'RESCHEDULED')
        return this.savedFromExisting(existing, !!profile?.verified);
      idempotencyKey = `${idempotencyKey}:again:${existing.id}`.slice(-180);
    }

    const requestedTime =
      input.when.time !== undefined
        ? formatClock(input.when.time)
        : (input.when.partOfDay ?? null);

    // CRITICAL WRITE: row + outbox atomically, before any acknowledgement.
    let appointment: Appointment;
    try {
      appointment = await this.createRequested(input, {
        idempotencyKey,
        date,
        requestedTime,
        requestedAt,
        tz,
        profile,
      });
    } catch (e: unknown) {
      if (
        !(
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002'
        )
      )
        throw e;
      // A concurrent identical request won the insert. Never book twice: report the winner's
      // state (waiting briefly for its provider answer when a slot is being booked).
      const winner = await this.awaitSibling(
        input.tenantId,
        idempotencyKey,
        !!input.providerSlot,
      );
      if (!winner) throw e;
      if (winner.status === 'CANCELLED' || winner.status === 'RESCHEDULED')
        return {
          status: 'rejected',
          code: 'unavailable',
          alternatives: [],
          timezone: tz,
        };
      return this.savedFromExisting(winner, !!profile?.verified);
    }
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
    let provider: ProviderConfirmation | undefined;
    let final = appointment;
    if (requestedAt) {
      const scheduler = await this.registry.resolve(
        input.tenantId,
        input.locationId,
        input.type as SchedulingDepartment,
      );
      if (scheduler?.adapter.create) {
        const ctx = this.registry.context(
          scheduler,
          input.tenantId,
          input.locationId,
          idempotencyKey,
          appointment.id,
          input.now,
        );
        let res: SchedulingOutcome;
        // create() threw or timed out: the provider may STILL have booked (a late success).
        let unknownOutcome: string | null = null;
        try {
          res = await withTimeout(
            scheduler.adapter.create(ctx, {
              department: input.type as SchedulingDepartment,
              startUtc: requestedAt.toISOString(),
              durationMinutes: DURATION[input.type],
              providerSlotId: input.providerSlot?.providerSlotId,
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
          // A short code only — never the adapter's exception text (it can echo customer data).
          unknownOutcome = providerErrorCode(e);
          res = { kind: 'failed', errorCode: unknownOutcome, retryable: true };
        }
        let applied: { appointment: Appointment; conflict?: boolean };
        if (unknownOutcome) {
          applied = await this.recordUnknownOutcome(
            appointment,
            scheduler,
            unknownOutcome,
            idempotencyKey,
          );
        } else {
          try {
            applied = await this.applyProviderOutcome(
              appointment,
              scheduler,
              res,
              idempotencyKey,
            );
          } catch (e) {
            if (res.kind !== 'confirmed' && res.kind !== 'pending') throw e;
            // The provider HOLDS a booking that could not be recorded. Never report it as
            // confirmed, never leave it orphaned: queue the compensation (or cancel right now).
            applied = await this.compensateUnrecordedBooking(
              appointment,
              scheduler,
              ctx,
              idempotencyKey,
              e,
            );
            res = {
              kind: 'failed',
              errorCode: 'confirm_persist_failed',
              retryable: true,
            };
          }
        }
        final = applied.appointment;
        // The provider reference already backs another appointment: not ours to confirm.
        if (applied.conflict)
          res = { kind: 'unavailable', reason: 'provider_ref_conflict' };
        if (res.kind === 'confirmed') {
          outcome = 'confirmed';
          provider = {
            ref: res.externalId,
            name: scheduler.displayName,
            sandbox: isSandboxBooking(scheduler),
            startsAt: res.scheduledAtUtc,
          };
          // A sandbox (demo) booking never enrols customer reminders.
          if (!isSandboxBooking(scheduler))
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

    await this.reportToLead(final);
    return {
      status: 'saved',
      appointment: final,
      outcome,
      hoursVerified: !!profile?.verified,
      providerFailure,
      ...(provider ? { provider } : {}),
    };
  }

  private createRequested(
    input: AppointmentRequestInput,
    p: {
      idempotencyKey: string;
      date: LocalDate;
      requestedTime: string | null;
      requestedAt: Date | null;
      tz: string;
      profile: HoursProfile | null;
    },
  ): Promise<Appointment> {
    const { idempotencyKey, date, requestedTime, requestedAt, tz, profile } = p;
    return this.prisma.$transaction(async (tx) => {
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
  }

  /**
   * Slots a customer may pick right now — only from a scheduler the registry resolves for
   * this tenant/location/department (enabled + liveReady connection, adapter registered, all
   * gates passed) that can both read availability and create bookings. Null means "no
   * authorised scheduler": the caller must fall back to a request, never invent availability.
   */
  async offerableSlots(p: {
    tenantId: string;
    locationId?: string | null;
    type: AppointmentType;
    now: Date;
    horizonDays?: number;
  }): Promise<{
    connectionId: string;
    provider: string;
    displayName: string;
    sandbox: boolean;
    slots: AvailabilitySlot[];
  } | null> {
    const scheduler = await this.registry.resolve(
      p.tenantId,
      p.locationId,
      p.type as SchedulingDepartment,
    );
    const caps = scheduler?.adapter.capabilities();
    if (
      !scheduler ||
      !caps?.availabilityRead ||
      !caps.create ||
      !scheduler.adapter.getAvailability ||
      !scheduler.adapter.create
    )
      return null;
    const ctx = this.registry.context(
      scheduler,
      p.tenantId,
      p.locationId,
      `availability:${randomUUID()}`,
      'availability',
      p.now,
    );
    try {
      const slots = await withTimeout(
        scheduler.adapter.getAvailability(ctx, {
          department: p.type as SchedulingDepartment,
          fromUtc: p.now.toISOString(),
          toUtc: new Date(
            p.now.getTime() + (p.horizonDays ?? 7) * 86_400_000,
          ).toISOString(),
        }),
        ctx.timeoutMs,
      );
      this.breaker.recordSuccess(`scheduler:${scheduler.connectionId}`);
      return {
        connectionId: scheduler.connectionId,
        provider: scheduler.provider,
        displayName: scheduler.displayName,
        sandbox: isSandboxBooking(scheduler),
        slots,
      };
    } catch {
      this.breaker.recordFailure(`scheduler:${scheduler.connectionId}`);
      this.metrics.increment('appointments.availability_failed');
      return null;
    }
  }

  /** Result for a request that already has a live row (idempotent replay). */
  private async savedFromExisting(
    existing: Appointment,
    hoursVerified: boolean,
  ): Promise<AppointmentRequestResult> {
    const outcome =
      existing.status === 'CONFIRMED'
        ? 'confirmed'
        : existing.status === 'PENDING_CONFIRMATION'
          ? 'pending'
          : 'requested';
    const provider =
      outcome === 'confirmed'
        ? await this.providerConfirmation(existing)
        : undefined;
    return {
      status: 'saved',
      appointment: existing,
      outcome,
      hoursVerified,
      ...(provider ? { provider } : {}),
    };
  }

  /** Provider confirmation for a CONFIRMED appointment, from its CONFIRMED receipt only. */
  async providerConfirmation(
    appt: Pick<Appointment, 'id' | 'tenantId' | 'status' | 'provider'>,
  ): Promise<ProviderConfirmation | undefined> {
    if (appt.status !== 'CONFIRMED' || appt.provider === 'NONE')
      return undefined;
    const receipt = await this.prisma.appointmentProviderReceipt.findFirst({
      where: {
        tenantId: appt.tenantId,
        appointmentId: appt.id,
        status: 'CONFIRMED',
      },
      orderBy: { receivedAt: 'desc' },
    });
    if (!receipt) return undefined;
    const adapter = this.registry.adapterFor(receipt.provider);
    return {
      ref: receipt.providerRef,
      name: adapter?.displayName ?? receipt.provider,
      sandbox: receipt.sandbox,
      startsAt: receipt.confirmedStart?.toISOString() ?? null,
    };
  }

  /** Wait (briefly) for the concurrent request that owns this idempotency key. */
  private async awaitSibling(
    tenantId: string,
    idempotencyKey: string,
    waitForProvider: boolean,
  ): Promise<Appointment | null> {
    for (let i = 0; i < 20; i += 1) {
      const row = await this.prisma.appointment.findUnique({
        where: { tenantId_idempotencyKey: { tenantId, idempotencyKey } },
      });
      if (
        row &&
        (!waitForProvider ||
          row.status !== 'REQUESTED' ||
          row.provider !== 'NONE')
      )
        return row;
      await new Promise((r) => setTimeout(r, 100));
    }
    return this.prisma.appointment.findUnique({
      where: { tenantId_idempotencyKey: { tenantId, idempotencyKey } },
    });
  }

  private async writeReceipt(
    db: Pick<Prisma.TransactionClient, 'appointmentProviderReceipt'>,
    appt: Appointment,
    scheduler: Pick<ResolvedScheduler, 'provider' | 'sandbox' | 'mode'>,
    r: {
      status:
        | 'CONFIRMED'
        | 'PENDING'
        | 'UNAVAILABLE'
        | 'FAILED'
        | 'CONFLICT'
        /** create() threw / timed out, or its confirmation could not be persisted. */
        | 'UNKNOWN'
        /** Compensation results (see reconcileProviderBooking). */
        | 'NOT_FOUND'
        | 'ORPHAN_CANCELLED'
        /** The provider released a booking after the appointment was cancelled or moved. */
        | 'CANCELLED';
      providerRef?: string | null;
      confirmedStart?: Date | null;
      rawStatus?: string | null;
      idempotencyKey: string;
    },
  ) {
    return db.appointmentProviderReceipt.create({
      data: {
        tenantId: appt.tenantId,
        appointmentId: appt.id,
        provider: scheduler.provider,
        providerRef: r.providerRef ?? null,
        status: r.status,
        confirmedStart: r.confirmedStart ?? null,
        rawStatus: r.rawStatus?.slice(0, 120) ?? null,
        idempotencyKey: r.idempotencyKey,
        sandbox: isSandboxBooking(scheduler),
      },
    });
  }

  /**
   * Applies ONE provider response: writes its receipt and keeps the Appointment.provider*
   * columns in sync. CONFIRMED is set only in the same transaction that inserts the CONFIRMED
   * receipt; if that provider reference already backs another appointment the insert fails
   * (unique tenant+provider+providerRef) and nothing is confirmed (`conflict: true`).
   */
  private async applyProviderOutcome(
    appt: Appointment,
    scheduler: ResolvedScheduler,
    res: SchedulingOutcome,
    idempotencyKey: string,
  ): Promise<{ appointment: Appointment; conflict?: boolean }> {
    const provider = scheduler.provider;
    const prov = { ...(appt.provenance as Record<string, unknown> | null) };
    switch (res.kind) {
      case 'confirmed': {
        try {
          const appointment = await this.prisma.$transaction(async (tx) => {
            await this.writeReceipt(tx, appt, scheduler, {
              status: 'CONFIRMED',
              providerRef: res.externalId,
              confirmedStart: new Date(res.scheduledAtUtc),
              rawStatus: res.rawStatus ?? res.providerStatus,
              idempotencyKey,
            });
            return tx.appointment.update({
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
          });
          this.metrics.increment('appointments.provider_confirmed');
          return { appointment };
        } catch (e: unknown) {
          if (
            !(
              e instanceof Prisma.PrismaClientKnownRequestError &&
              e.code === 'P2002'
            )
          )
            throw e;
          this.metrics.increment('appointments.provider_ref_conflict');
          const appointment = await this.prisma.$transaction(async (tx) => {
            await this.writeReceipt(tx, appt, scheduler, {
              status: 'CONFLICT',
              rawStatus: 'provider_ref_already_used',
              idempotencyKey,
            });
            return tx.appointment.update({
              where: { id: appt.id },
              data: {
                status: AppointmentStatus.CANCELLED,
                canceledAt: new Date(),
                cancelReason: 'provider_unavailable:provider_ref_conflict',
                provider,
              },
            });
          });
          return { appointment, conflict: true };
        }
      }
      case 'pending':
        await this.writeReceipt(this.prisma, appt, scheduler, {
          status: 'PENDING',
          providerRef: res.externalId ?? null,
          rawStatus: res.providerStatus,
          idempotencyKey,
        });
        return this.prisma.appointment
          .update({
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
          })
          .then((appointment) => ({ appointment }));
      case 'unavailable':
        await this.writeReceipt(this.prisma, appt, scheduler, {
          status: 'UNAVAILABLE',
          rawStatus: res.reason,
          idempotencyKey,
        });
        return this.prisma.appointment
          .update({
            where: { id: appt.id },
            data: {
              status: AppointmentStatus.CANCELLED,
              canceledAt: new Date(),
              cancelReason: `provider_unavailable:${res.reason}`.slice(0, 200),
              provider,
            },
          })
          .then((appointment) => ({ appointment }));
      case 'failed':
        this.metrics.increment('appointments.provider_failed');
        await this.writeReceipt(this.prisma, appt, scheduler, {
          status: 'FAILED',
          rawStatus: res.errorCode,
          idempotencyKey,
        });
        return this.prisma.appointment
          .update({
            where: { id: appt.id },
            data: {
              provider,
              providerStatus: `FAILED:${res.errorCode}`.slice(0, 120),
            },
          })
          .then((appointment) => ({ appointment }));
    }
  }

  /**
   * The provider's answer to create() is UNKNOWN (timeout / thrown error / a confirmation that
   * could not be persisted). One transaction: a receipt with the distinct status `UNKNOWN`, the
   * appointment marked `UNKNOWN:<code>` (it stays REQUESTED — never confirmed), and a
   * compensation job keyed by the booking idempotency key on the existing outbox.
   */
  private async recordUnknownOutcome(
    appt: Appointment,
    scheduler: ResolvedScheduler,
    code: string,
    idempotencyKey: string,
  ): Promise<{ appointment: Appointment }> {
    this.metrics.increment('appointments.provider_outcome_unknown');
    const appointment = await this.prisma.$transaction(async (tx) => {
      await this.writeReceipt(tx, appt, scheduler, {
        status: 'UNKNOWN',
        rawStatus: code,
        idempotencyKey,
      });
      await tx.outboxEvent.create({
        data: {
          tenantId: appt.tenantId,
          topic: APPOINTMENT_RECONCILE_TOPIC,
          idempotencyKey: `${APPOINTMENT_RECONCILE_TOPIC}:${idempotencyKey}`,
          payload: {
            appointmentId: appt.id,
            locationId: appt.locationId,
            provider: scheduler.provider,
            connectionId: scheduler.connectionId,
            mode: scheduler.mode,
            bookingIdempotencyKey: idempotencyKey,
            reason: code,
          } as Prisma.InputJsonValue,
        },
      });
      return tx.appointment.update({
        where: { id: appt.id },
        data: {
          provider: scheduler.provider,
          providerStatus: `UNKNOWN:${code}`.slice(0, 120),
        },
      });
    });
    return { appointment };
  }

  private async compensateUnrecordedBooking(
    appt: Appointment,
    scheduler: ResolvedScheduler,
    ctx: SchedulingContext,
    idempotencyKey: string,
    cause: unknown,
  ): Promise<{ appointment: Appointment }> {
    this.metrics.increment('appointments.confirm_persist_failed');
    for (let i = 0; i < 3; i += 1) {
      try {
        return await this.recordUnknownOutcome(
          appt,
          scheduler,
          'confirm_persist_failed',
          idempotencyKey,
        );
      } catch {
        await new Promise((r) => setTimeout(r, 50 * (i + 1)));
      }
    }
    // The database will not take the compensation job either: cancel at the provider NOW so no
    // booking outlives a request we cannot even record, then surface the original failure.
    try {
      await scheduler.adapter.cancelByIdempotencyKey?.(
        ctx,
        'confirm_persist_failed',
      );
    } catch {
      this.logger.error(
        `appointment ${appt.id}: provider booking could not be recorded or cancelled (key kept in logs for manual reconcile)`,
      );
    }
    throw cause;
  }

  /**
   * Compensation for an UNKNOWN create() outcome — cancel-or-reconcile, keyed by the booking
   * idempotency key (outbox topic `appointment.provider.reconcile`, at-least-once, idempotent):
   *
   *  - provider holds no booking under the key  → `NOT_FOUND` receipt; the request stays for staff;
   *  - provider holds one and the appointment is still REQUESTED / PENDING_CONFIRMATION
   *        → reconciled: the normal CONFIRMED receipt + CONFIRMED appointment (exactly one);
   *  - provider holds one and the appointment is already CONFIRMED under that reference → no-op;
   *  - otherwise (appointment cancelled / rescheduled / gone / confirmed elsewhere)
   *        → the orphan is cancelled at the provider and an `ORPHAN_CANCELLED` receipt is written.
   *
   * Throws to retry (outbox backoff) when the provider cannot be asked right now.
   */
  async reconcileProviderBooking(p: {
    tenantId: string;
    appointmentId: string;
    provider: string;
    connectionId: string;
    mode: 'sandbox' | 'production';
    bookingIdempotencyKey: string;
    locationId?: string | null;
  }): Promise<
    | 'no_provider_booking'
    | 'reconciled_confirmed'
    | 'already_confirmed'
    | 'orphan_cancelled'
    | 'adapter_cannot_reconcile'
  > {
    const adapter = this.registry.adapterFor(p.provider);
    if (
      !adapter ||
      typeof adapter.findByIdempotencyKey !== 'function' ||
      typeof adapter.cancelByIdempotencyKey !== 'function'
    )
      return 'adapter_cannot_reconcile';
    const appt = await this.prisma.appointment.findFirst({
      where: { id: p.appointmentId, tenantId: p.tenantId },
    });
    const scheduler: ResolvedScheduler = {
      adapter,
      connectionId: p.connectionId,
      provider: p.provider,
      mode: p.mode,
      sandbox: isSandboxBooking({ adapter, mode: p.mode }),
      displayName: adapter.displayName ?? p.provider,
    };
    const ctx = this.registry.context(
      scheduler,
      p.tenantId,
      appt?.locationId ?? p.locationId ?? null,
      p.bookingIdempotencyKey,
      p.appointmentId,
    );
    const found = await withTimeout(
      adapter.findByIdempotencyKey(ctx),
      ctx.timeoutMs,
    );
    if (!found) {
      if (appt) {
        await this.writeReceipt(this.prisma, appt, scheduler, {
          status: 'NOT_FOUND',
          rawStatus: 'reconcile_no_provider_booking',
          idempotencyKey: p.bookingIdempotencyKey,
        });
        if (appt.providerStatus?.startsWith('UNKNOWN:'))
          await this.prisma.appointment.update({
            where: { id: appt.id },
            data: { providerStatus: 'RECONCILED:no_provider_booking' },
          });
      }
      this.metrics.increment('appointments.reconcile.no_provider_booking');
      return 'no_provider_booking';
    }
    if (
      appt &&
      found.kind === 'confirmed' &&
      appt.status === 'CONFIRMED' &&
      appt.externalProviderId === found.externalId
    )
      return 'already_confirmed';
    if (
      appt &&
      found.kind === 'confirmed' &&
      (appt.status === 'REQUESTED' || appt.status === 'PENDING_CONFIRMATION')
    ) {
      const applied = await this.applyProviderOutcome(
        appt,
        scheduler,
        found,
        p.bookingIdempotencyKey,
      );
      // The CONFIRMED receipt (or the conflict) is committed: report that state, once.
      await this.reportToLead(applied.appointment);
      if (!applied.conflict) {
        if (!isSandboxBooking(scheduler))
          await this.enrollAppointmentReminder(p.tenantId, applied.appointment);
        this.metrics.increment('appointments.reconcile.confirmed');
        return 'reconciled_confirmed';
      }
      // The reference already backs another appointment: it is not an orphan — nothing to cancel.
      return 'already_confirmed';
    }
    if (appt && found.kind === 'pending' && appt.status === 'REQUESTED') {
      await this.applyProviderOutcome(
        appt,
        scheduler,
        found,
        p.bookingIdempotencyKey,
      );
      return 'reconciled_confirmed';
    }
    // Nobody is waiting for this booking any more: cancel the orphan at the provider.
    const cancelled = await withTimeout(
      adapter.cancelByIdempotencyKey(ctx, 'orphan_after_unknown_outcome'),
      ctx.timeoutMs,
    );
    if (appt)
      await this.writeReceipt(this.prisma, appt, scheduler, {
        status: 'ORPHAN_CANCELLED',
        rawStatus: cancelled.cancelled
          ? 'orphan_cancelled'
          : 'orphan_already_gone',
        idempotencyKey: p.bookingIdempotencyKey,
      });
    this.metrics.increment('appointments.reconcile.orphan_cancelled');
    return 'orphan_cancelled';
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
    await this.reportToLead(old);
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
    await this.reportToLead(updated);
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
    await this.reportToLead(updated);
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
      acknowledgeMissedRecovery?: boolean;
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

    if (patch.acknowledgeMissedRecovery) {
      const status = updated.status;
      if (status !== 'NO_SHOW' && status !== 'CANCELLED') {
        throw new BadRequestException(
          'Recovery ack applies to no-show or cancelled appointments only',
        );
      }
      const prov = {
        ...((updated.provenance as Record<string, unknown> | null) ?? {}),
      };
      updated = await this.prisma.appointment.update({
        where: { id: row.id },
        data: {
          provenance: {
            ...prov,
            recoveryAcknowledgedAt: new Date().toISOString(),
            recoveryAckBy: `staff:${userId}`,
          },
        },
      });
    }

    if (
      notesChanged ||
      (patch.status !== undefined && patch.status !== row.status) ||
      patch.acknowledgeEscalation ||
      patch.acknowledgeMissedRecovery
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
              status: patch.status ?? updated.status,
              notesUpdated: notesChanged,
              escalationAcknowledged: !!patch.acknowledgeEscalation,
              missedRecoveryAcknowledged: !!patch.acknowledgeMissedRecovery,
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
    const when = [row.requestedDate, row.requestedTime]
      .filter(Boolean)
      .join(' ');
    const need = row.serviceType ? ` · ${row.serviceType}` : '';
    await this.prisma.escalation.create({
      data: {
        tenantId: row.tenantId,
        locationId: row.locationId,
        conversationId: row.conversationId,
        reason: 'SERVICE_ADVISOR',
        urgency: 'NORMAL',
        summary:
          `Service appointment request needs confirmation${need}${when ? ` · ${when}` : ''}`.slice(
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

  /**
   * Releases a provider-owned booking after its appointment was cancelled or rescheduled
   * (outbox topic `appointment.provider.cancel`). Never changes the appointment's own status:
   * that was decided by whoever cancelled it.
   *
   *  - no adapter that can cancel, or the rooftop's scheduler is no longer this provider
   *        → `no_authorized_scheduler` (the caller dead-letters; staff release it by hand);
   *  - the appointment is active again under the same reference → nothing is cancelled;
   *  - otherwise the adapter is asked to cancel and a `CANCELLED` receipt records the result.
   *
   * Throws to retry (outbox backoff) when the provider cannot be asked right now.
   */
  async cancelProviderBooking(p: {
    tenantId: string;
    appointmentId: string;
  }): Promise<
    | 'provider_cancelled'
    | 'nothing_to_cancel'
    | 'still_active'
    | 'no_authorized_scheduler'
  > {
    const appt = await this.prisma.appointment.findFirst({
      where: { id: p.appointmentId, tenantId: p.tenantId },
    });
    if (!appt || !appt.externalProviderId || appt.provider === 'NONE')
      return 'nothing_to_cancel';
    if (
      appt.status !== AppointmentStatus.CANCELLED &&
      appt.status !== AppointmentStatus.RESCHEDULED
    )
      return 'still_active';
    const scheduler = await this.registry.resolve(
      appt.tenantId,
      appt.locationId,
      appt.type as SchedulingDepartment,
    );
    if (
      !scheduler ||
      scheduler.provider !== appt.provider ||
      typeof scheduler.adapter.cancel !== 'function'
    )
      return 'no_authorized_scheduler';
    const idempotencyKey = `provider-cancel:${appt.id}`;
    const ctx = this.registry.context(
      scheduler,
      appt.tenantId,
      appt.locationId,
      idempotencyKey,
      appt.id,
    );
    await withTimeout(
      scheduler.adapter.cancel(ctx, appt.externalProviderId),
      ctx.timeoutMs,
    );
    await this.writeReceipt(this.prisma, appt, scheduler, {
      status: 'CANCELLED',
      rawStatus: 'provider_cancelled',
      idempotencyKey,
    });
    this.metrics.increment('appointments.provider_cancelled');
    return 'provider_cancelled';
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
        t = setTimeout(() => rej(new ProviderTimeoutError()), ms);
      }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
}

export { parseIsoDate };
