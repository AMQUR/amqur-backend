import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  LeadAppointmentUpdate,
  LeadAppointmentUpdateStatus,
  LeadDelivery,
  OutboxStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { FeatureFlagsService } from '../../feature-flags/feature-flags.service';
import { MetricsService } from '../../observability/metrics.service';
import { OUTBOX_MAX_ATTEMPTS, OutboxService } from '../core/outbox.service';
import {
  OutboxHandlerResult,
  OutboxProcessorService,
  PermanentOutboxError,
} from '../core/outbox-processor.service';
import { AdfSerializationError, serializeAdf } from './adf-serializer';
import { validateAdfRoundTrip } from './adf-validator';
import { mapLeadToAdf } from './adf-lead-mapper';
import { destinationDomain, UnsafeHeaderValueError } from './destination';
import {
  acknowledgementCountsForMode,
  ADF_FEATURE_FLAG,
  checkDestinationForMode,
  departmentForLeadSource,
  effectiveMode,
  evaluateSendGates,
  leadDeliveryIdempotencyKey,
  readLeadDeliveryEnv,
  SENT_STALE_MS,
} from './lead-delivery-gates';
import { LeadDeliveryRouteService } from './lead-delivery-route.service';
import { LeadDeliveryService } from './lead-delivery.service';
import {
  appointmentRefFor,
  appointmentUpdateIdempotencyKey,
  AppointmentUpdateState,
  confirmedReceiptOf,
  deriveAppointmentUpdateState,
  hasSandboxReceipt,
  LEAD_ACCEPTED_STATUSES,
  leadRefFor,
  leadStandingForUpdate,
  planAppointmentUpdateText,
} from './lead-appointment-update';
import {
  LeadDeliveryTransport,
  LeadTransportError,
  TransportReceipt,
} from './transports/lead-delivery-transport';
import { SandboxSinkTransport } from './transports/sandbox-sink.transport';
import { SmtpLeadTransport } from './transports/smtp.transport';

/** Distinct from the lead topic on purpose: code that predates R8 has no handler for it. */
export const LEAD_APPOINTMENT_UPDATE_TOPIC =
  'lead.delivery.adf.appointment-update';
/** `reason` of a NOT_SENT row: the destination has not confirmed any update protocol. */
export const UPDATES_NOT_SUPPORTED = 'destination_does_not_accept_updates';
/** Same meaning as for a lead delivery: accepted by the transport, record still outstanding. */
const ACCEPT_RECORD_PENDING = 'accepted_record_pending';
const ABANDONABLE_UPDATE_STATUSES: LeadAppointmentUpdateStatus[] = [
  'QUEUED',
  'SENT',
  'FAILED',
];
/** A lead change only looks at appointments touched this recently (no retroactive floods). */
export const APPOINTMENT_SYNC_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type AppointmentUpdateResult =
  | { status: 'recorded'; updateId: string; queued: boolean }
  | { status: 'exists'; updateId: string }
  | { status: 'skipped'; reason: string };

type AcceptedReceipt = TransportReceipt & { providerMessageId: string };

/** Staff-safe projection: ids, states and codes only — no address, no customer contact data. */
export const APPOINTMENT_UPDATE_SELECT = {
  id: true,
  appointmentId: true,
  state: true,
  status: true,
  leadRef: true,
  sandboxReceipt: true,
  deliveryMode: true,
  reason: true,
  attempts: true,
  providerName: true,
  providerMessageId: true,
  lastErrorCode: true,
  sentAt: true,
  acceptedAt: true,
  blockedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * R8 — the appointment is a SEPARATE event from the lead (PROPOSED policy; verified in the
 * local sandbox only, against no real CRM). See docs/ADF_LEAD_DELIVERY.md, section R8.
 *
 * This service never creates a lead delivery and never touches one's status. For a lead that
 * already has its delivery row it records at most ONE update per (lead, appointment, state):
 *
 *  - destination without the explicit, default-off `appointmentUpdates` capability → the row is
 *    NOT_SENT (nothing is queued, nothing is sent; the appointment stays visible to staff only);
 *  - destination with `ADF_FOLLOW_UP` → the row is queued on the outbox and, once the ORIGINAL
 *    lead delivery is accepted, sent as a follow-up ADF document that carries the SAME lead
 *    reference to the SAME route, through every gate a lead delivery passes.
 */
@Injectable()
export class LeadAppointmentUpdateService implements OnModuleInit {
  private readonly logger = new Logger(LeadAppointmentUpdateService.name);
  private readonly unrecordedReceipts = new Map<string, AcceptedReceipt>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly processor: OutboxProcessorService,
    private readonly flags: FeatureFlagsService,
    private readonly routes: LeadDeliveryRouteService,
    private readonly deliveries: LeadDeliveryService,
    private readonly metrics: MetricsService,
    private readonly sink: SandboxSinkTransport,
    private readonly smtp: SmtpLeadTransport,
  ) {}

  onModuleInit() {
    this.processor.registerHandler(LEAD_APPOINTMENT_UPDATE_TOPIC, (p, m) => {
      if (typeof p.updateId !== 'string')
        throw new PermanentOutboxError('bad_payload');
      return this.process(p.updateId, m);
    });
    this.processor.registerAbandonHandler(
      LEAD_APPOINTMENT_UPDATE_TOPIC,
      async (payload, meta) => {
        if (typeof payload.updateId === 'string') {
          await this.settleBehindDeadOutbox({
            id: payload.updateId,
            tenantId: meta.tenantId,
            outboxEventId: meta.id,
          });
        }
      },
    );
    // The moment a lead delivery is accepted, the updates held for it may follow.
    this.deliveries.onAccepted((d) =>
      this.releaseWaiting({ deliveryId: d.id }),
    );
  }

  // ───────────────────────────────────────── recording

  private skip(reason: string): AppointmentUpdateResult {
    this.metrics.increment(`adf.appointment_update.skipped.${reason}`);
    return { status: 'skipped', reason };
  }

  /**
   * Called on every lead change (after the lead delivery was enqueued). Picks up appointments
   * that were linked to the lead after they were made. Does nothing — not even an appointment
   * query — while ADF delivery is off for the rooftop or globally.
   */
  async syncLead(tenantId: string, leadId: string): Promise<number> {
    if (!readLeadDeliveryEnv().sendEnabled) return 0;
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, tenantId },
      select: { id: true, tenantId: true, locationId: true },
    });
    if (!lead) return 0;
    const flags = await this.flags.resolve(lead.tenantId, lead.locationId);
    if (flags[ADF_FEATURE_FLAG] !== true) return 0;
    const appts = await this.prisma.appointment.findMany({
      where: {
        tenantId,
        leadId,
        updatedAt: { gte: new Date(Date.now() - APPOINTMENT_SYNC_WINDOW_MS) },
      },
      orderBy: { createdAt: 'asc' },
      take: 20,
      select: { id: true },
    });
    let recorded = 0;
    for (const a of appts) {
      const r = await this.syncAppointment(tenantId, a.id);
      if (r.status === 'recorded') recorded += 1;
    }
    return recorded;
  }

  /**
   * Idempotent: derives the appointment's CURRENT update state from its row and receipts and
   * makes sure the one row for (lead, appointment, state) exists. A duplicate, replayed or late
   * event finds the row and changes nothing. Tenant comes from the caller's own scope; the lead
   * and the appointment must both belong to it.
   */
  async syncAppointment(
    tenantId: string,
    appointmentId: string,
  ): Promise<AppointmentUpdateResult> {
    if (!readLeadDeliveryEnv().sendEnabled) return this.skip('send_disabled');
    const appt = await this.prisma.appointment.findFirst({
      where: { id: appointmentId, tenantId },
    });
    if (!appt) return this.skip('appointment_not_found');
    if (!appt.leadId) return this.skip('no_lead');
    // Appointment.leadId is a plain column: it is only honoured for a lead of the SAME tenant.
    const lead = await this.prisma.lead.findFirst({
      where: { id: appt.leadId, tenantId },
      select: { id: true, tenantId: true, locationId: true, source: true },
    });
    if (!lead) {
      this.metrics.increment('adf.appointment_update.cross_tenant_refused');
      return this.skip('lead_not_in_tenant');
    }
    // Another rooftop's appointment is not reported on this rooftop's lead route.
    if ((appt.locationId ?? null) !== (lead.locationId ?? null))
      return this.skip('appointment_location_differs');
    const flags = await this.flags.resolve(lead.tenantId, lead.locationId);
    if (flags[ADF_FEATURE_FLAG] !== true) return this.skip('flag_off');

    // The ORIGINAL lead delivery. No delivery row ⇒ no update row: this service never creates
    // (or stands in for) a lead delivery.
    const delivery = await this.prisma.leadDelivery.findUnique({
      where: {
        tenantId_idempotencyKey: {
          tenantId: lead.tenantId,
          idempotencyKey: leadDeliveryIdempotencyKey({
            leadId: lead.id,
            channel: 'ADF_EMAIL',
            locationId: lead.locationId,
            department: departmentForLeadSource(lead.source),
          }),
        },
      },
    });
    if (!delivery) return this.skip('no_lead_delivery');

    const [receipts, reported] = await Promise.all([
      this.prisma.appointmentProviderReceipt.findMany({
        where: { tenantId, appointmentId: appt.id },
      }),
      this.prisma.leadAppointmentUpdate.count({
        where: { tenantId, appointmentId: appt.id },
      }),
    ]);
    const state = deriveAppointmentUpdateState(appt, receipts, {
      previouslyReported: reported > 0,
    });
    if (!state) return this.skip('no_reportable_state');
    const receipt =
      state === 'CONFIRMED' ? confirmedReceiptOf(appt, receipts) : null;
    // Defence in depth: the derivation already requires it.
    if (state === 'CONFIRMED' && !receipt)
      return this.skip('no_provider_receipt');

    const idempotencyKey = appointmentUpdateIdempotencyKey({
      leadId: lead.id,
      appointmentId: appt.id,
      state,
    });
    const byKey = {
      tenantId_idempotencyKey: { tenantId: lead.tenantId, idempotencyKey },
    };
    const existing = await this.prisma.leadAppointmentUpdate.findUnique({
      where: byKey,
      select: { id: true },
    });
    if (existing) return { status: 'exists', updateId: existing.id };

    const route = await this.routes.findForLead(
      delivery.tenantId,
      delivery.locationId,
      delivery.department,
    );
    const supported = route?.appointmentUpdates === 'ADF_FOLLOW_UP';
    try {
      const updateId = await this.prisma.$transaction(async (tx) => {
        const u = await tx.leadAppointmentUpdate.create({
          data: {
            tenantId: lead.tenantId,
            locationId: delivery.locationId,
            leadId: lead.id,
            leadDeliveryId: delivery.id,
            appointmentId: appt.id,
            state,
            status: supported ? 'QUEUED' : 'NOT_SENT',
            reason: supported ? null : UPDATES_NOT_SUPPORTED,
            leadRef: leadRefFor(lead.id),
            receiptId: receipt?.id ?? null,
            sandboxReceipt: hasSandboxReceipt(appt, receipts),
            idempotencyKey,
            correlationId: randomUUID(),
          },
          select: { id: true },
        });
        // Truthful note in the lead delivery's own history (what the operator console reads).
        await this.note(tx, delivery, {
          reasonCode: supported
            ? 'appointment_update_queued'
            : 'appointment_update_not_sent',
          updateId: u.id,
          appointmentId: appt.id,
          state,
          sent: false,
          reason: supported ? null : UPDATES_NOT_SUPPORTED,
        });
        if (supported) {
          // Reference only — never an email, phone or name.
          const ev = await this.outbox.enqueue({
            tenantId: lead.tenantId,
            topic: LEAD_APPOINTMENT_UPDATE_TOPIC,
            idempotencyKey,
            payload: { updateId: u.id },
            tx,
          });
          await tx.leadAppointmentUpdate.update({
            where: { id: u.id },
            data: { outboxEventId: ev.id },
          });
        }
        return u.id;
      });
      this.metrics.increment(
        supported
          ? 'adf.appointment_update.queued'
          : 'adf.appointment_update.not_sent',
      );
      return { status: 'recorded', updateId, queued: supported };
    } catch (e: unknown) {
      // Concurrent duplicate event: the unique (tenantId, idempotencyKey) picked one winner.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const winner = await this.prisma.leadAppointmentUpdate.findUnique({
          where: byKey,
          select: { id: true },
        });
        if (winner) return { status: 'exists', updateId: winner.id };
      }
      throw e;
    }
  }

  /**
   * History row on the ORIGINAL lead delivery. `fromStatus === toStatus`: the lead delivery's
   * status is never changed by an appointment update.
   */
  private async note(
    db: Pick<Prisma.TransactionClient, 'leadDeliveryEvent' | 'leadDelivery'>,
    delivery: Pick<LeadDelivery, 'id' | 'tenantId'>,
    n: {
      reasonCode: string;
      updateId: string;
      appointmentId: string;
      state: string;
      sent: boolean;
      reason?: string | null;
      mode?: string | null;
    },
  ): Promise<void> {
    const cur = await db.leadDelivery.findFirst({
      where: { id: delivery.id, tenantId: delivery.tenantId },
      select: { status: true },
    });
    if (!cur) return;
    await db.leadDeliveryEvent.create({
      data: {
        tenantId: delivery.tenantId,
        deliveryId: delivery.id,
        fromStatus: cur.status,
        toStatus: cur.status,
        reasonCode: n.reasonCode,
        evidence: {
          kind: 'appointment_update',
          updateId: n.updateId,
          appointmentId: n.appointmentId,
          state: n.state,
          sent: n.sent,
          reason: n.reason ?? null,
          mode: n.mode ?? null,
        } as Prisma.InputJsonValue,
      },
    });
  }

  // ───────────────────────────────────────── state persistence

  /** Compare-and-set on the current status. Returns false when the row moved meanwhile. */
  private async move(
    u: Pick<LeadAppointmentUpdate, 'id' | 'tenantId' | 'status'>,
    to: LeadAppointmentUpdateStatus,
    data: Prisma.LeadAppointmentUpdateUncheckedUpdateManyInput = {},
    where: Prisma.LeadAppointmentUpdateWhereInput = {},
  ): Promise<boolean> {
    const res = await this.prisma.leadAppointmentUpdate.updateMany({
      where: { id: u.id, tenantId: u.tenantId, status: u.status, ...where },
      data: { status: to, ...data },
    });
    if (res.count === 1)
      this.metrics.increment(`adf.appointment_update.${to.toLowerCase()}`);
    return res.count === 1;
  }

  /** Only a STALE in-flight attempt (crashed worker) may be taken over, never an accepted one. */
  private staleSentWhere(
    u: Pick<LeadAppointmentUpdate, 'status'>,
  ): Prisma.LeadAppointmentUpdateWhereInput {
    if (u.status !== 'SENT') return {};
    return {
      updatedAt: { lt: new Date(Date.now() - SENT_STALE_MS) },
      OR: [
        { lastErrorCode: null },
        { lastErrorCode: { not: ACCEPT_RECORD_PENDING } },
      ],
    };
  }

  private async block(
    u: LeadAppointmentUpdate,
    delivery: Pick<LeadDelivery, 'id' | 'tenantId'> | null,
    reason: string,
  ): Promise<OutboxHandlerResult> {
    const blocked = await this.move(
      u,
      'BLOCKED',
      { reason, blockedAt: new Date() },
      this.staleSentWhere(u),
    );
    if (!blocked && u.status === 'SENT') throw new Error('update_in_flight');
    if (blocked && delivery)
      await this.note(this.prisma, delivery, {
        reasonCode: 'appointment_update_blocked',
        updateId: u.id,
        appointmentId: u.appointmentId,
        state: u.state,
        sent: false,
        reason,
      });
    this.logger.warn(
      `appointment update ${u.id} BLOCKED reason=${reason} tenant=${u.tenantId}`,
    );
    return { note: `blocked:${reason}` };
  }

  private async dead(
    u: Pick<LeadAppointmentUpdate, 'id' | 'tenantId' | 'status'>,
    code: string,
  ): Promise<never> {
    await this.move(u, 'DEAD', {
      lastErrorCode: code,
      lastErrorAt: new Date(),
      deadAt: new Date(),
    });
    this.logger.error(`appointment update ${u.id} DEAD code=${code}`);
    throw new PermanentOutboxError(code);
  }

  // ───────────────────────────────────────── outbox handler

  async process(
    updateId: string,
    meta: { id: string; tenantId: string; attempts: number },
  ): Promise<OutboxHandlerResult> {
    try {
      return await this.attempt(updateId, meta);
    } catch (e: unknown) {
      // The final outbox attempt never leaves a row non-terminal behind a DEAD outbox event.
      if (
        !(e instanceof PermanentOutboxError) &&
        meta.attempts >= OUTBOX_MAX_ATTEMPTS
      ) {
        const msg = e instanceof Error ? e.message : '';
        const code = /^[a-z0-9_]{1,60}$/.test(msg) ? msg : 'handler_error';
        const cur = await this.prisma.leadAppointmentUpdate
          .findFirst({ where: { id: updateId, tenantId: meta.tenantId } })
          .catch(() => null);
        if (
          cur &&
          ['QUEUED', 'SENT', 'FAILED'].includes(cur.status) &&
          !this.pendingReceipt(cur)
        )
          await this.move(cur, 'DEAD', {
            lastErrorCode: code,
            lastErrorAt: new Date(),
            deadAt: new Date(),
          }).catch(() => undefined);
      }
      throw e;
    }
  }

  private async attempt(
    updateId: string,
    meta: { id: string; tenantId: string; attempts: number },
  ): Promise<OutboxHandlerResult> {
    const u = await this.prisma.leadAppointmentUpdate.findFirst({
      where: { id: updateId, tenantId: meta.tenantId },
    });
    if (!u) throw new PermanentOutboxError('update_not_found');
    if (u.status === 'ACCEPTED') return { note: 'already_accepted' };
    if (
      u.status === 'NOT_SENT' ||
      u.status === 'BLOCKED' ||
      u.status === 'DEAD'
    )
      return { note: `not_replayed:${u.status.toLowerCase()}` };
    const pending = this.pendingReceipt(u);
    if (pending) return this.recordAccepted(u, pending, null);

    const [delivery, lead, appt] = await Promise.all([
      this.prisma.leadDelivery.findFirst({
        where: { id: u.leadDeliveryId, tenantId: u.tenantId },
      }),
      this.prisma.lead.findFirst({
        where: { id: u.leadId, tenantId: u.tenantId },
      }),
      this.prisma.appointment.findFirst({
        where: { id: u.appointmentId, tenantId: u.tenantId },
      }),
    ]);
    // Every reference must resolve inside the update's OWN tenant and point at the same lead.
    if (
      !delivery ||
      !lead ||
      !appt ||
      delivery.leadId !== lead.id ||
      appt.leadId !== lead.id ||
      u.leadRef !== leadRefFor(lead.id)
    ) {
      this.metrics.increment('adf.appointment_update.cross_tenant_refused');
      return this.block(u, delivery, 'lead_appointment_mismatch');
    }
    const env = readLeadDeliveryEnv();
    if (
      (lead.locationId ?? null) !== (delivery.locationId ?? null) ||
      (appt.locationId ?? null) !== (delivery.locationId ?? null)
    )
      return this.block(u, delivery, 'lead_location_changed');

    // QUEUE / SKIP RULE — never before the original lead delivery was accepted.
    const standing = leadStandingForUpdate({
      leadDeliveryStatus: delivery.status,
      acknowledgementCounts: acknowledgementCountsForMode(
        delivery.deliveryMode,
        env,
      ),
    });
    if (standing.kind === 'refuse')
      return this.block(u, delivery, standing.reason);
    if (standing.kind === 'wait') {
      const held = await this.move(
        u,
        'WAITING_FOR_LEAD',
        { reason: standing.reason },
        this.staleSentWhere(u),
      );
      if (!held && u.status === 'SENT') throw new Error('update_in_flight');
      return { note: `waiting_for_lead:${standing.reason}` };
    }

    // The very same gates a lead delivery passes, evaluated at SEND time.
    const flags = await this.flags.resolve(
      delivery.tenantId,
      delivery.locationId,
    );
    const route = await this.routes.findForLead(
      delivery.tenantId,
      delivery.locationId,
      delivery.department,
    );
    const consent = await this.deliveries.consentStanding(lead);
    const gate = evaluateSendGates({
      env,
      flagEnabled: flags[ADF_FEATURE_FLAG] === true,
      lead: {
        tenantId: delivery.tenantId,
        locationId: delivery.locationId,
        hasContactMethod: Boolean(lead.email || lead.phone),
        optedOut: consent.doNotContact,
        spam: lead.status === 'SPAM',
      },
      route,
    });
    if (!gate.open) return this.block(u, delivery, gate.reason);
    if (!route) return this.block(u, delivery, 'no_route');
    // Only to the SAME verified route — and the same mailbox — the lead itself went to.
    if (
      route.id !== delivery.routeId ||
      route.destinationFingerprint !== delivery.destinationFingerprint
    )
      return this.block(u, delivery, 'route_changed_since_lead');
    if (gate.mode !== delivery.deliveryMode)
      return this.block(u, delivery, 'delivery_mode_differs_from_lead');
    if (route.appointmentUpdates !== 'ADF_FOLLOW_UP')
      return this.block(u, delivery, UPDATES_NOT_SUPPORTED);
    const destination = this.routes.revealDestination(route);
    if (!destination) return this.block(u, delivery, 'destination_unavailable');
    const destCheck = checkDestinationForMode({
      mode: gate.mode,
      transport: gate.transport,
      destination,
      smtpHost: env.smtp.host,
    });
    if (!destCheck.ok) return this.block(u, delivery, destCheck.reason);

    // The update describes ONE state. If the appointment has moved on, it is not sent.
    const receipts = await this.prisma.appointmentProviderReceipt.findMany({
      where: { tenantId: u.tenantId, appointmentId: appt.id },
    });
    // A "confirmed" update without a valid CONFIRMED provider receipt is never sent — whatever
    // the update row or the appointment row claims.
    if (u.state === 'CONFIRMED' && !confirmedReceiptOf(appt, receipts))
      return this.block(u, delivery, 'no_provider_receipt');
    const current = deriveAppointmentUpdateState(appt, receipts, {
      previouslyReported: true,
    });
    if (current !== u.state)
      return this.block(u, delivery, 'superseded_by_later_state');
    const plan = planAppointmentUpdateText({
      state: u.state as AppointmentUpdateState,
      appointment: appt,
      receipts,
      mode: gate.mode,
    });
    if (!plan.ok) return this.block(u, delivery, plan.reason);

    const [tenant, vehicle] = await Promise.all([
      this.prisma.tenant.findUnique({
        where: { id: lead.tenantId },
        select: { name: true },
      }),
      lead.interestedVin
        ? this.prisma.vehicle.findUnique({
            where: {
              tenantId_vin: {
                tenantId: lead.tenantId,
                vin: lead.interestedVin,
              },
            },
            select: {
              vin: true,
              stock: true,
              year: true,
              make: true,
              model: true,
              trim: true,
              condition: true,
            },
          })
        : null,
    ]);
    let xml: string;
    try {
      // Same mapper, same lead reference, same request date as the original lead document.
      const base = mapLeadToAdf({
        lead,
        department: delivery.department,
        vendorName: tenant?.name ?? '',
        providerName: env.providerName,
        vehicle,
        appointment: null,
        consent: {
          text: consent.text,
          email: consent.email,
          call: consent.call,
        },
      });
      const dto = {
        ...base,
        prospectStatus: 'resend' as const,
        comments: {
          ...base.comments,
          followUp: {
            leadRef: base.leadRef,
            appointmentRef: appointmentRefFor(appt.id),
            state: u.state,
            text: plan.text,
            recordedAt: u.createdAt.toISOString(),
          },
        },
      };
      xml = serializeAdf(dto, { maxBytes: env.maxBytes });
      const valid = validateAdfRoundTrip(dto, xml, { maxBytes: env.maxBytes });
      if (!valid.ok) return await this.dead(u, valid.code);
      if (valid.summary.leadRef !== u.leadRef)
        return await this.dead(u, 'adf_lead_ref_mismatch');
    } catch (e: unknown) {
      if (e instanceof PermanentOutboxError) throw e;
      return this.dead(
        u,
        e instanceof AdfSerializationError ? e.code : 'adf_build_failed',
      );
    }

    // FINAL GUARD, immediately before transport.
    if (
      route.tenantId !== lead.tenantId ||
      route.tenantId !== u.tenantId ||
      route.tenantId !== appt.tenantId ||
      route.locationId !== delivery.locationId ||
      route.locationId !== lead.locationId
    ) {
      this.metrics.increment('adf.appointment_update.cross_tenant_refused');
      return this.block(u, delivery, 'route_tenant_mismatch');
    }

    const attempt = u.attempts + 1;
    const claimed = await this.move(
      u,
      'SENT',
      {
        attempts: attempt,
        sentAt: new Date(),
        reason: null,
        deliveryMode: gate.mode,
        routeId: route.id,
        destinationFingerprint: route.destinationFingerprint,
        destinationMasked: route.destinationMasked,
        payloadSha256: createHash('sha256').update(xml).digest('hex'),
        payloadBytes: Buffer.byteLength(xml, 'utf8'),
      },
      this.staleSentWhere(u),
    );
    if (!claimed) throw new Error('update_in_flight');
    const sent = { id: u.id, tenantId: u.tenantId, status: 'SENT' as const };

    const transport: LeadDeliveryTransport =
      gate.transport === 'smtp' ? this.smtp : this.sink;
    let receipt: AcceptedReceipt;
    try {
      const r = await this.deliveries.sendWithinDeadline(
        env.sendDeadlineMs,
        () =>
          transport.send(
            {
              deliveryId: u.id,
              tenantId: u.tenantId,
              routeId: route.id,
              correlationId: u.correlationId,
              // Stable across retries so a receiver can de-duplicate an at-least-once resend.
              messageId: `<lead-appointment-update.${u.id}@${destinationDomain(env.fromAddress) || 'amqur.example.invalid'}>`,
              from: env.fromAddress,
              to: destination,
              subject: `Appointment update for lead ${u.leadRef}`,
              xml,
              format: route.format,
              date: new Date(),
            },
            { live: gate.mode === 'live' },
          ),
      );
      if (!r.accepted || !r.providerMessageId)
        throw new LeadTransportError('transport_not_accepted', true);
      receipt = { ...r, providerMessageId: r.providerMessageId };
    } catch (e: unknown) {
      const err =
        e instanceof LeadTransportError
          ? e
          : e instanceof UnsafeHeaderValueError
            ? new LeadTransportError('unsafe_header_value', false)
            : new LeadTransportError('transport_error', true);
      if (!err.retryable || meta.attempts >= OUTBOX_MAX_ATTEMPTS)
        return this.dead(sent, err.code);
      await this.move(sent, 'FAILED', {
        lastErrorCode: err.code,
        lastErrorAt: new Date(),
        failedAt: new Date(),
      });
      // Code only — never a provider message that could echo an address.
      throw new Error(err.code);
    }
    return this.recordAccepted(sent, receipt, {
      delivery,
      appointmentId: appt.id,
      state: u.state,
      mode: gate.mode,
    });
  }

  private pendingReceipt(u: LeadAppointmentUpdate): AcceptedReceipt | null {
    if (u.status !== 'SENT') return null;
    const remembered = this.unrecordedReceipts.get(u.id);
    if (remembered) return remembered;
    if (
      u.lastErrorCode === ACCEPT_RECORD_PENDING &&
      u.providerName &&
      u.providerMessageId
    )
      return {
        accepted: true,
        providerName: u.providerName,
        providerMessageId: u.providerMessageId,
        rawStatus: u.providerRawStatus || 'no_status',
        at: u.acceptedAt ?? new Date(),
      };
    return null;
  }

  private async settleBehindDeadOutbox(key: {
    id: string;
    tenantId: string;
    outboxEventId: string;
  }): Promise<boolean> {
    const update = await this.prisma.leadAppointmentUpdate.findFirst({
      where: { ...key, status: { in: ABANDONABLE_UPDATE_STATUSES } },
    });
    if (!update) return false;

    const pending = this.pendingReceipt(update);
    if (pending) {
      await this.recordAccepted(update, pending, null);
      return true;
    }

    const now = new Date();
    return this.move(
      update,
      'DEAD',
      {
        lastErrorCode: 'outbox_abandoned',
        lastErrorAt: now,
        deadAt: now,
      },
      { outboxEventId: key.outboxEventId, lastErrorCode: update.lastErrorCode },
    );
  }

  async sweepBehindDeadOutbox(limit = 200): Promise<number> {
    const take = Math.min(Math.max(limit, 1), 500);
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; tenantId: string; outboxEventId: string }>
    >`
      SELECT u."id", u."tenantId", u."outboxEventId"
        FROM "LeadAppointmentUpdate" u
        JOIN "OutboxEvent" o
          ON o."id" = u."outboxEventId" AND o."tenantId" = u."tenantId"
       WHERE u."status" IN (${Prisma.join(
         ABANDONABLE_UPDATE_STATUSES.map(
           (status) => Prisma.sql`${status}::"LeadAppointmentUpdateStatus"`,
         ),
       )})
         AND o."topic" = ${LEAD_APPOINTMENT_UPDATE_TOPIC}
         AND o."status" = 'DEAD'::"OutboxStatus"
       ORDER BY u."updatedAt", u."id"
       LIMIT ${take}`;
    let settled = 0;
    for (const row of rows) {
      try {
        if (await this.settleBehindDeadOutbox(row)) settled += 1;
      } catch {
        this.logger.warn(`appointment update ${row.id} settlement will retry`);
      }
    }
    return settled;
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async sweepBehindDeadOutboxTick(): Promise<void> {
    if (process.env.OUTBOX_PROCESSOR_ENABLED === 'false') return;
    try {
      await this.sweepBehindDeadOutbox();
    } catch {
      this.logger.warn('appointment update dead-outbox sweep failed');
    }
  }

  /**
   * The transport ACCEPTED. From here the row is never marked FAILED and never re-sent: the
   * ACCEPTED write is retried; if it still cannot be committed the receipt is stored on the
   * SENT row (`accepted_record_pending`) and the next outbox attempt finalises it.
   */
  private async recordAccepted(
    sent: Pick<LeadAppointmentUpdate, 'id' | 'tenantId'>,
    receipt: AcceptedReceipt,
    ctx: {
      delivery: Pick<LeadDelivery, 'id' | 'tenantId'>;
      appointmentId: string;
      state: string;
      mode: string;
    } | null,
  ): Promise<OutboxHandlerResult> {
    const row = { id: sent.id, tenantId: sent.tenantId };
    const receiptData = {
      providerName: receipt.providerName,
      providerMessageId: receipt.providerMessageId,
      providerRawStatus: receipt.rawStatus,
      acceptedAt: receipt.at,
    };
    for (let i = 1; i <= 3; i += 1) {
      try {
        const moved = await this.move({ ...row, status: 'SENT' }, 'ACCEPTED', {
          ...receiptData,
          lastErrorCode: null,
        });
        this.unrecordedReceipts.delete(row.id);
        if (moved) {
          const full = await this.prisma.leadAppointmentUpdate.findFirst({
            where: row,
          });
          const delivery = ctx?.delivery ?? {
            id: full?.leadDeliveryId ?? '',
            tenantId: row.tenantId,
          };
          await this.note(this.prisma, delivery, {
            reasonCode: 'appointment_update_accepted',
            updateId: row.id,
            appointmentId: ctx?.appointmentId ?? full?.appointmentId ?? '',
            state: ctx?.state ?? full?.state ?? '',
            sent: true,
            mode: ctx?.mode ?? full?.deliveryMode ?? null,
          }).catch(() => undefined);
        }
        return {
          note: moved
            ? `accepted:${receipt.providerName}`
            : 'accepted:already_recorded',
        };
      } catch {
        if (i < 3) await new Promise((r) => setTimeout(r, 75 * i));
      }
    }
    this.metrics.increment('adf.appointment_update.accept_record_pending');
    this.unrecordedReceipts.set(row.id, receipt);
    try {
      await this.prisma.leadAppointmentUpdate.updateMany({
        where: { ...row, status: 'SENT' },
        data: {
          ...receiptData,
          lastErrorCode: ACCEPT_RECORD_PENDING,
          lastErrorAt: new Date(),
        },
      });
      this.unrecordedReceipts.delete(row.id);
    } catch {
      this.logger.error(
        `appointment update ${row.id} accepted; receipt kept in memory`,
      );
    }
    // Retry the OUTBOX event (not the send): the next attempt finalises from the receipt.
    throw new Error(ACCEPT_RECORD_PENDING);
  }

  // ───────────────────────────────────────── releasing held updates

  /**
   * Re-queue updates held as WAITING_FOR_LEAD whose original lead delivery has since been
   * accepted. The handler re-checks everything; this only makes the outbox look again.
   */
  async releaseWaiting(
    opts: { deliveryId?: string; tenantId?: string; limit?: number } = {},
  ): Promise<number> {
    const env = readLeadDeliveryEnv();
    if (!env.sendEnabled) return 0;
    const rows = await this.prisma.leadAppointmentUpdate.findMany({
      where: {
        status: 'WAITING_FOR_LEAD',
        ...(opts.deliveryId ? { leadDeliveryId: opts.deliveryId } : {}),
        ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
        leadDelivery: {
          status: { in: [...LEAD_ACCEPTED_STATUSES] },
          // A sandbox acknowledgement does not release anything in a live environment.
          ...(effectiveMode(env) === 'live' ? { deliveryMode: 'live' } : {}),
        },
      },
      orderBy: { createdAt: 'asc' },
      take: Math.min(Math.max(opts.limit ?? 200, 1), 500),
    });
    let released = 0;
    for (const u of rows) {
      try {
        const ok = await this.prisma.$transaction(async (tx) => {
          const moved = await tx.leadAppointmentUpdate.updateMany({
            where: {
              id: u.id,
              tenantId: u.tenantId,
              status: 'WAITING_FOR_LEAD',
            },
            data: { status: 'QUEUED', reason: null },
          });
          if (moved.count !== 1) return false;
          // Re-arm the SAME outbox event: one in-flight job per update, ever.
          const rearmed = u.outboxEventId
            ? await tx.outboxEvent.updateMany({
                where: {
                  id: u.outboxEventId,
                  tenantId: u.tenantId,
                  status: { not: OutboxStatus.PROCESSING },
                },
                data: {
                  status: OutboxStatus.PENDING,
                  attempts: 0,
                  nextAttemptAt: new Date(),
                  lastError: null,
                },
              })
            : { count: 0 };
          if (rearmed.count !== 1) throw new Error('update_in_flight');
          return true;
        });
        if (ok) released += 1;
      } catch {
        // In flight or changed concurrently — the next sweep picks it up.
      }
    }
    if (released > 0)
      this.metrics.increment('adf.appointment_update.released', released);
    return released;
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async releaseWaitingTick(): Promise<void> {
    if (process.env.OUTBOX_PROCESSOR_ENABLED === 'false') return;
    try {
      await this.releaseWaiting();
    } catch {
      this.logger.warn('appointment update release sweep failed');
    }
  }

  // ───────────────────────────────────────── operator read

  /** The updates recorded for one lead (tenant-scoped, staff-safe projection). */
  listForLead(tenantId: string, leadId: string) {
    return this.prisma.leadAppointmentUpdate.findMany({
      where: { tenantId, leadId },
      orderBy: { createdAt: 'asc' },
      select: APPOINTMENT_UPDATE_SELECT,
    });
  }
}
