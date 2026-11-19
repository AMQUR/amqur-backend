import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  LeadDelivery,
  LeadDeliveryChannel,
  LeadDeliveryStatus,
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
  leadConsentEndpoints,
  LeadConsentStanding,
  resolveLeadConsentStanding,
  StandingLead,
} from './lead-consent-standing';
import {
  acknowledgementCountsForMode,
  ADF_FEATURE_FLAG,
  blockReasonStillApplies,
  checkDestinationForMode,
  departmentForLeadSource,
  evaluateSendGates,
  leadDeliveryIdempotencyKey,
  readLeadDeliveryEnv,
  REEVALUABLE_BLOCK_REASONS,
  reservedRecipientRequired,
  SENT_STALE_MS,
} from './lead-delivery-gates';
import {
  DeliveryEvidence,
  DeliveryStatus,
  isAcknowledged,
  REPLAYABLE_STATUSES,
  STATUS_TIMESTAMP_COLUMN,
  transitionDelivery,
} from './lead-delivery-state';
import { LeadDeliveryRouteService } from './lead-delivery-route.service';
import {
  LeadDeliveryTransport,
  LeadTransportError,
  SEND_DEADLINE_CODE,
  TransportReceipt,
} from './transports/lead-delivery-transport';
import { HANDSET_CONSENT_SOURCES } from '../../messaging/handset-opt-out';
import { SandboxSinkTransport } from './transports/sandbox-sink.transport';
import { redactForLog } from '../../common/security/sensitive-data';
import { SmtpLeadTransport } from './transports/smtp.transport';

export const LEAD_DELIVERY_TOPIC = 'lead.delivery.adf';
/**
 * A SENT row older than this with no outcome is treated as a crashed attempt and retried.
 * Always exceeds the hard send deadline plus a margin (see lead-delivery-gates.ts).
 */
export { SENT_STALE_MS };
/**
 * `lastErrorCode` of a SENT row whose transport ACCEPTED the message but whose ACCEPTED write
 * could not be committed. The receipt columns are already stored; the row is finalised to
 * ACCEPTED from them on the next attempt and is NEVER handed to a transport again.
 */
export const ACCEPT_RECORD_PENDING = 'accepted_record_pending';
/** `lastErrorCode` of a row dead-lettered because its outbox event was abandoned (no handler run). */
export const OUTBOX_ABANDONED_CODE = 'outbox_abandoned';
/** Same outcome, found by the defensive sweep rather than the abandon hook. */
export const OUTBOX_DEAD_SWEEP_CODE = 'outbox_dead_sweep';
const ACCEPT_WRITE_ATTEMPTS = 3;
const ACCEPT_WRITE_BACKOFF_MS = 75;

type Db = Prisma.TransactionClient | PrismaService;
type AcceptedReceipt = TransportReceipt & { providerMessageId: string };

export type EnqueueResult =
  | { status: 'enqueued'; deliveryId: string }
  | { status: 'exists'; deliveryId: string }
  | { status: 'skipped'; reason: string };

export type ReconcileResult = 'CRM_PARSED' | 'CRM_MATCHED' | 'CRM_REJECTED';

/** Staff-safe projection: no destination address, no customer contact data. */
const DELIVERY_SELECT = {
  id: true,
  tenantId: true,
  locationId: true,
  leadId: true,
  channel: true,
  department: true,
  routeId: true,
  destinationMasked: true,
  status: true,
  deliveryMode: true,
  attempts: true,
  replayCount: true,
  providerName: true,
  providerMessageId: true,
  providerRawStatus: true,
  crmRecordRef: true,
  payloadSha256: true,
  payloadBytes: true,
  blockedReason: true,
  lastErrorCode: true,
  lastErrorAt: true,
  queuedAt: true,
  sentAt: true,
  acceptedAt: true,
  deliveredAt: true,
  crmParsedAt: true,
  crmMatchedAt: true,
  crmRejectedAt: true,
  failedAt: true,
  deadAt: true,
  blockedAt: true,
  correlationId: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Per-rooftop ADF lead delivery. Enqueue writes the delivery row and its outbox event in one
 * transaction; the outbox worker evaluates every gate, builds + validates the ADF document and
 * hands it to exactly one transport. No PII is logged, stored in the outbox, or put in metrics.
 */
@Injectable()
export class LeadDeliveryService implements OnModuleInit {
  private readonly logger = new Logger(LeadDeliveryService.name);
  /**
   * Receipts of accepted sends whose ACCEPTED write AND durable marker both failed (database
   * unreachable). Kept in memory so this process finalises the row instead of re-sending.
   */
  private readonly unrecordedReceipts = new Map<string, AcceptedReceipt>();
  /** R8: told (best effort) when a lead delivery is recorded ACCEPTED. Never affects it. */
  private readonly acceptedListeners: Array<
    (d: { id: string; tenantId: string }) => Promise<unknown>
  > = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly processor: OutboxProcessorService,
    private readonly flags: FeatureFlagsService,
    private readonly routes: LeadDeliveryRouteService,
    private readonly metrics: MetricsService,
    private readonly sink: SandboxSinkTransport,
    private readonly smtp: SmtpLeadTransport,
  ) {}

  onModuleInit() {
    this.processor.registerAbandonHandler(LEAD_DELIVERY_TOPIC, async (p, m) => {
      if (typeof p.deliveryId === 'string')
        await this.settleBehindDeadOutbox(p.deliveryId, m.tenantId);
    });
    this.processor.registerHandler(LEAD_DELIVERY_TOPIC, (p, m) => {
      if (typeof p.deliveryId !== 'string')
        throw new PermanentOutboxError('bad_payload');
      return this.process(p.deliveryId, m);
    });
  }

  /** R8: appointment updates held for a lead are released when its delivery is accepted. */
  onAccepted(
    listener: (d: { id: string; tenantId: string }) => Promise<unknown>,
  ): void {
    this.acceptedListeners.push(listener);
  }

  // ───────────────────────────────────────── enqueue

  /**
   * Called on every lead change. Idempotent per (tenant, lead, channel, route): a double-submit,
   * a retry or a later lead update never creates a second row or a second outbox event.
   * Tenant, location and department all come from the LEAD ROW — never from the caller.
   */
  async enqueueForLead(
    tenantId: string,
    leadId: string,
  ): Promise<EnqueueResult> {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, tenantId },
      select: {
        id: true,
        tenantId: true,
        locationId: true,
        email: true,
        phone: true,
        source: true,
      },
    });
    if (!lead) return this.skip('lead_not_found');
    const flags = await this.flags.resolve(lead.tenantId, lead.locationId);
    if (flags[ADF_FEATURE_FLAG] !== true) return this.skip('flag_off');
    // Master switch off ⇒ no row at all (exactly like the rooftop flag being off). A row here
    // would sit BLOCKED `send_disabled` and read as a delivery problem when nothing is wrong.
    if (!readLeadDeliveryEnv().sendEnabled) return this.skip('send_disabled');
    // Nothing to hand a CRM yet; a later lead update with a contact method enqueues.
    if (!lead.email && !lead.phone) return this.skip('no_contact_method');

    const department = departmentForLeadSource(lead.source);
    const channel = LeadDeliveryChannel.ADF_EMAIL;
    const idempotencyKey = leadDeliveryIdempotencyKey({
      leadId: lead.id,
      channel,
      locationId: lead.locationId,
      department,
    });
    const byKey = {
      tenantId_idempotencyKey: { tenantId: lead.tenantId, idempotencyKey },
    };
    const existing = await this.prisma.leadDelivery.findUnique({
      where: byKey,
    });
    if (existing) {
      // A sandbox acknowledgement is not an acknowledgement for a live route: queue it again.
      await this.supersedeSandboxAck(existing, 'system');
      return { status: 'exists', deliveryId: existing.id };
    }

    const t = transitionDelivery(null, 'QUEUED', { kind: 'enqueued' });
    if (!t.ok || t.noop) throw new Error('lead_delivery_enqueue_transition');
    try {
      const deliveryId = await this.prisma.$transaction(async (tx) => {
        const d = await tx.leadDelivery.create({
          data: {
            tenantId: lead.tenantId,
            locationId: lead.locationId,
            leadId: lead.id,
            channel,
            department,
            idempotencyKey,
            status: 'QUEUED',
            correlationId: randomUUID(),
          },
          select: { id: true },
        });
        await tx.leadDeliveryEvent.create({
          data: {
            tenantId: lead.tenantId,
            deliveryId: d.id,
            fromStatus: null,
            toStatus: 'QUEUED',
            reasonCode: 'enqueued',
          },
        });
        // The outbox payload is a REFERENCE only — never an email, phone or name.
        const ev = await this.outbox.enqueue({
          tenantId: lead.tenantId,
          topic: LEAD_DELIVERY_TOPIC,
          idempotencyKey,
          payload: { deliveryId: d.id },
          tx,
        });
        await tx.leadDelivery.update({
          where: { id: d.id },
          data: { outboxEventId: ev.id },
        });
        return d.id;
      });
      this.metrics.increment('adf.delivery.enqueued');
      return { status: 'enqueued', deliveryId };
    } catch (e: unknown) {
      // Concurrent double-submit: the unique (tenantId, idempotencyKey) picked one winner.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const winner = await this.prisma.leadDelivery.findUnique({
          where: byKey,
          select: { id: true },
        });
        if (winner) return { status: 'exists', deliveryId: winner.id };
      }
      throw e;
    }
  }

  private skip(reason: string): EnqueueResult {
    this.metrics.increment(`adf.delivery.skipped.${reason}`);
    return { status: 'skipped', reason };
  }

  // ───────────────────────────────────────── state persistence

  /**
   * Apply one transition through the pure state machine, compare-and-set on the current status,
   * and append the history row. Returns false when nothing changed (no-op or lost race).
   */
  private async apply(
    db: Db,
    d: Pick<LeadDelivery, 'id' | 'tenantId' | 'status'>,
    to: DeliveryStatus,
    evidence: DeliveryEvidence,
    opts: {
      data?: Prisma.LeadDeliveryUncheckedUpdateManyInput;
      reasonCode?: string;
      actor?: string;
      /** Extra CAS predicate (e.g. stale-SENT reclaim). */
      where?: Prisma.LeadDeliveryWhereInput;
    } = {},
  ): Promise<boolean> {
    const res = transitionDelivery(d.status, to, evidence);
    if (!res.ok) {
      this.metrics.increment('adf.delivery.illegal_transition');
      throw new ConflictException(res.reason);
    }
    if (res.noop) return false;
    const now = new Date();
    const updated = await db.leadDelivery.updateMany({
      where: {
        id: d.id,
        tenantId: d.tenantId,
        status: d.status,
        ...opts.where,
      },
      data: {
        status: to as LeadDeliveryStatus,
        [STATUS_TIMESTAMP_COLUMN[to]]: now,
        ...opts.data,
      },
    });
    if (updated.count !== 1) return false;
    await db.leadDeliveryEvent.create({
      data: {
        tenantId: d.tenantId,
        deliveryId: d.id,
        fromStatus: d.status,
        toStatus: to as LeadDeliveryStatus,
        reasonCode: opts.reasonCode ?? evidence.kind,
        evidence: evidence as unknown as Prisma.InputJsonValue,
        actor: opts.actor ?? 'system',
      },
    });
    this.metrics.increment(`adf.delivery.${to.toLowerCase()}`);
    return true;
  }

  /**
   * Extra compare-and-set predicate for acting on a row that is already SENT: only a STALE
   * attempt (crashed worker) may be taken over, and never one whose send was accepted.
   */
  private staleSentWhere(
    d: Pick<LeadDelivery, 'status'>,
  ): Prisma.LeadDeliveryWhereInput | undefined {
    if (d.status !== 'SENT') return undefined;
    return {
      updatedAt: { lt: new Date(Date.now() - SENT_STALE_MS) },
      // Accepted-but-unrecorded rows are finalised, never re-sent.
      OR: [
        { lastErrorCode: null },
        { lastErrorCode: { not: ACCEPT_RECORD_PENDING } },
      ],
    };
  }

  private async block(
    d: LeadDelivery,
    reason: string,
  ): Promise<OutboxHandlerResult> {
    const blocked = await this.apply(
      this.prisma,
      d,
      'BLOCKED',
      { kind: 'gate_blocked', reason },
      {
        data: { blockedReason: reason },
        reasonCode: reason,
        where: this.staleSentWhere(d),
      },
    );
    // A SENT row that is NOT stale is another worker's live attempt: leave it alone, retry later.
    if (!blocked && d.status === 'SENT') throw new Error('delivery_in_flight');
    this.logger.warn(
      `lead delivery ${d.id} BLOCKED reason=${reason} tenant=${d.tenantId}`,
    );
    return { note: `blocked:${reason}` };
  }

  private async dead(
    d: Pick<LeadDelivery, 'id' | 'tenantId' | 'status'>,
    evidence: DeliveryEvidence,
    code: string,
  ): Promise<never> {
    await this.apply(this.prisma, d, 'DEAD', evidence, {
      data: { lastErrorCode: code, lastErrorAt: new Date() },
      reasonCode: code,
    });
    this.logger.error(`lead delivery ${d.id} DEAD code=${code}`);
    throw new PermanentOutboxError(code);
  }

  /**
   * Resolve the customer's standing from the consent ledger for the lead's own email / phone
   * within the lead's own tenant. Endpoints are PII: queried, never logged.
   * (Also used, unchanged, by the R8 appointment update at ITS send time.)
   */
  async consentStanding(
    lead: StandingLead & { tenantId: string },
  ): Promise<LeadConsentStanding> {
    const ep = leadConsentEndpoints(lead);
    const endpoints = [ep.email, ep.phone].filter(
      (e): e is string => e !== null,
    );
    const rows = endpoints.length
      ? await this.prisma.consentRecord.findMany({
          where: {
            tenantId: lead.tenantId,
            endpoint: { in: endpoints },
            revokedAt: null,
          },
          orderBy: { createdAt: 'desc' },
          take: 200,
          select: {
            channel: true,
            endpoint: true,
            granted: true,
            createdAt: true,
            evidence: true,
            source: true,
          },
        })
      : [];
    // The latest handset/provider text record is fetched on its own: no number of later form
    // grants can push a STOP out of the window above.
    const handset = ep.phone
      ? await this.prisma.consentRecord.findFirst({
          where: {
            tenantId: lead.tenantId,
            channel: 'SMS',
            endpoint: ep.phone,
            revokedAt: null,
            source: { in: [...HANDSET_CONSENT_SOURCES] },
          },
          orderBy: [{ createdAt: 'desc' }, { granted: 'asc' }],
          select: {
            channel: true,
            endpoint: true,
            granted: true,
            createdAt: true,
            evidence: true,
            source: true,
          },
        })
      : null;
    const standing = resolveLeadConsentStanding(
      lead,
      handset ? [...rows, handset] : rows,
    );
    if (standing.doNotContact)
      this.metrics.increment(`adf.delivery.consent.${standing.reason}`);
    return standing;
  }

  // ───────────────────────────────────────── outbox handler

  /**
   * Outbox entry point. Whatever the attempt throws, the FINAL outbox attempt never leaves the
   * row in a non-terminal state behind a DEAD outbox event: it becomes DEAD (replayable).
   */
  async process(
    deliveryId: string,
    meta: { id: string; tenantId: string; attempts: number },
  ): Promise<OutboxHandlerResult> {
    try {
      return await this.attempt(deliveryId, meta);
    } catch (e: unknown) {
      if (
        !(e instanceof PermanentOutboxError) &&
        meta.attempts >= OUTBOX_MAX_ATTEMPTS
      )
        await this.deadOnFinalAttempt(deliveryId, meta.tenantId, e);
      throw e;
    }
  }

  private async deadOnFinalAttempt(
    deliveryId: string,
    tenantId: string,
    cause: unknown,
  ): Promise<void> {
    // Codes only: an arbitrary exception message could echo an address.
    const msg = cause instanceof Error ? cause.message : '';
    const code = /^[a-z0-9_]{1,60}$/.test(msg) ? msg : 'handler_error';
    try {
      const cur = await this.prisma.leadDelivery.findFirst({
        where: { id: deliveryId, tenantId },
      });
      if (!cur || !['QUEUED', 'SENT', 'FAILED'].includes(cur.status)) return;
      // The transport accepted this one; it is finalised, never dead-lettered for replay.
      if (this.pendingReceipt(cur)) return;
      await this.apply(
        this.prisma,
        cur,
        'DEAD',
        { kind: 'attempts_exhausted', code },
        {
          data: { lastErrorCode: code, lastErrorAt: new Date() },
          reasonCode: code,
        },
      );
      this.logger.error(
        `lead delivery ${deliveryId} DEAD code=${code} (outbox attempts exhausted)`,
      );
    } catch {
      this.logger.error(
        `lead delivery ${deliveryId} could not be dead-lettered on the final attempt`,
      );
    }
  }

  /**
   * The delivery's outbox event is DEAD and its handler will not run again (abandoned after
   * repeated lease expiry, or any other path that left the row behind). Bring the row to a
   * terminal, operator-visible state:
   *  - accepted by the transport but not yet recorded → FINALISED to ACCEPTED from the stored
   *    receipt; never dead-lettered, never re-sent;
   *  - otherwise QUEUED / SENT / FAILED → DEAD (replayable by an operator).
   * Idempotent; anything already terminal is left alone.
   */
  async settleBehindDeadOutbox(
    deliveryId: string,
    tenantId: string,
    code = OUTBOX_ABANDONED_CODE,
  ): Promise<'accepted' | 'dead' | 'unchanged'> {
    const cur = await this.prisma.leadDelivery.findFirst({
      where: { id: deliveryId, tenantId },
    });
    if (!cur || !['QUEUED', 'SENT', 'FAILED'].includes(cur.status))
      return 'unchanged';
    const receipt = this.pendingReceipt(cur);
    if (receipt) {
      try {
        await this.recordAccepted(cur, receipt);
      } catch {
        // Still pending (database trouble): the sweep finalises it on a later pass.
        return 'unchanged';
      }
      return 'accepted';
    }
    const moved = await this.apply(
      this.prisma,
      cur,
      'DEAD',
      { kind: 'attempts_exhausted', code },
      {
        data: { lastErrorCode: code, lastErrorAt: new Date() },
        reasonCode: code,
      },
    );
    if (moved)
      this.logger.error(
        `lead delivery ${deliveryId} DEAD code=${code} (outbox event dead-lettered without a handler run)`,
      );
    return moved ? 'dead' : 'unchanged';
  }

  /**
   * Defensive sweep: a delivery must never sit in QUEUED / SENT / FAILED behind a DEAD outbox
   * event (nothing would ever move it, and replay refuses QUEUED / SENT). Whatever left it there,
   * settle it. Bounded; returns how many rows changed.
   */
  async sweepBehindDeadOutbox(
    opts: { limit?: number; tenantId?: string } = {},
  ): Promise<number> {
    const take = Math.min(Math.max(opts.limit ?? 200, 1), 500);
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; tenantId: string }>
    >`
      SELECT d."id", d."tenantId"
        FROM "LeadDelivery" d
        JOIN "OutboxEvent" o ON o."id" = d."outboxEventId"
       WHERE d."status" IN ('QUEUED', 'SENT', 'FAILED')
         AND o."status" = 'DEAD'::"OutboxStatus"
         AND (${opts.tenantId ?? null}::text IS NULL OR d."tenantId" = ${opts.tenantId ?? null})
       ORDER BY d."createdAt" ASC
       LIMIT ${take}`;
    let settled = 0;
    for (const r of rows) {
      try {
        const res = await this.settleBehindDeadOutbox(
          r.id,
          r.tenantId,
          OUTBOX_DEAD_SWEEP_CODE,
        );
        if (res !== 'unchanged') settled += 1;
      } catch {
        // Changed concurrently — the next sweep looks again.
      }
    }
    if (settled > 0) {
      this.metrics.increment('adf.delivery.dead_outbox_swept', settled);
      this.logger.error(
        `lead delivery sweep settled ${settled} row(s) stranded behind a DEAD outbox event`,
      );
    }
    return settled;
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async sweepBehindDeadOutboxTick(): Promise<void> {
    if (process.env.OUTBOX_PROCESSOR_ENABLED === 'false') return;
    try {
      await this.sweepBehindDeadOutbox();
    } catch {
      this.logger.warn('lead delivery dead-outbox sweep failed');
    }
  }

  private async attempt(
    deliveryId: string,
    meta: { id: string; tenantId: string; attempts: number },
  ): Promise<OutboxHandlerResult> {
    const d = await this.prisma.leadDelivery.findFirst({
      where: { id: deliveryId, tenantId: meta.tenantId },
    });
    if (!d) throw new PermanentOutboxError('delivery_not_found');
    // An acknowledged delivery is never handed to a transport again. (A SANDBOX acknowledgement
    // in a live environment is not re-sent from here either: it is re-queued explicitly by
    // supersedeSandboxAck — on the next lead change or an operator replay.)
    if (isAcknowledged(d.status))
      return {
        note: acknowledgementCountsForMode(
          d.deliveryMode,
          readLeadDeliveryEnv(),
        )
          ? 'already_acknowledged'
          : 'sandbox_ack_not_live',
      };
    if (d.status === 'DEAD' || d.status === 'BLOCKED')
      return { note: `not_replayed:${d.status.toLowerCase()}` };
    // The transport already accepted this delivery; only the record is outstanding. Finalise
    // it from the stored / remembered receipt — never send again.
    const pending = this.pendingReceipt(d);
    if (pending) return this.recordAccepted(d, pending);

    const lead = await this.prisma.lead.findFirst({
      where: { id: d.leadId, tenantId: d.tenantId },
    });
    if (!lead)
      return this.dead(
        d,
        { kind: 'invalid_payload', code: 'lead_missing' },
        'lead_missing',
      );

    const env = readLeadDeliveryEnv();
    // The delivery row was created for ONE rooftop (its locationId is part of the idempotency
    // key). Flags, routing and the final guard use THAT rooftop — never wherever the lead is
    // now. A lead that has since moved to another rooftop is not sent to the old one.
    if ((lead.locationId ?? null) !== (d.locationId ?? null))
      return this.block(d, 'lead_location_changed');
    const flags = await this.flags.resolve(d.tenantId, d.locationId);
    const route = await this.routes.findForLead(
      d.tenantId,
      d.locationId,
      d.department,
    );
    // Consent standing comes from the append-only ledger at SEND time (and so on every replay).
    const standing = await this.consentStanding(lead);
    const gate = evaluateSendGates({
      env,
      flagEnabled: flags[ADF_FEATURE_FLAG] === true,
      lead: {
        tenantId: d.tenantId,
        locationId: d.locationId,
        hasContactMethod: Boolean(lead.email || lead.phone),
        optedOut: standing.doNotContact,
        spam: lead.status === 'SPAM',
      },
      route,
    });
    if (!gate.open) return this.block(d, gate.reason);
    if (!route) return this.block(d, 'no_route');

    const destination = this.routes.revealDestination(route);
    if (!destination) return this.block(d, 'destination_unavailable');
    const destCheck = checkDestinationForMode({
      mode: gate.mode,
      transport: gate.transport,
      destination,
      smtpHost: env.smtp.host,
      requireReservedRecipient: reservedRecipientRequired(env),
    });
    if (!destCheck.ok) return this.block(d, destCheck.reason);

    // Build + validate. An invalid document is dead-lettered and never reaches a transport.
    const [tenant, vehicle, appointment] = await Promise.all([
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
      this.prisma.appointment.findFirst({
        where: { tenantId: lead.tenantId, leadId: lead.id },
        orderBy: { createdAt: 'desc' },
        select: {
          type: true,
          status: true,
          availabilityVerified: true,
          requestedDate: true,
          requestedTime: true,
          scheduledAt: true,
          timezone: true,
        },
      }),
    ]);
    let xml: string;
    try {
      const dto = mapLeadToAdf({
        lead,
        department: d.department,
        vendorName: tenant?.name ?? '',
        providerName: env.providerName,
        vehicle,
        appointment,
        consent: {
          text: standing.text,
          email: standing.email,
          call: standing.call,
        },
      });
      xml = serializeAdf(dto, { maxBytes: env.maxBytes });
      const valid = validateAdfRoundTrip(dto, xml, { maxBytes: env.maxBytes });
      if (!valid.ok)
        return await this.dead(
          d,
          { kind: 'invalid_payload', code: valid.code },
          valid.code,
        );
    } catch (e: unknown) {
      if (e instanceof PermanentOutboxError) throw e;
      const code =
        e instanceof AdfSerializationError ? e.code : 'adf_build_failed';
      return this.dead(d, { kind: 'invalid_payload', code }, code);
    }

    // FINAL GUARD, immediately before transport: the route is the DELIVERY ROW's own tenant +
    // rooftop, and the lead still belongs to both.
    if (
      route.tenantId !== lead.tenantId ||
      route.tenantId !== d.tenantId ||
      route.locationId !== d.locationId ||
      route.locationId !== lead.locationId
    ) {
      this.metrics.increment('adf.delivery.cross_tenant_guard_tripped');
      return this.block(d, 'route_tenant_mismatch');
    }

    const attempt = d.attempts + 1;
    const claimed = await this.apply(
      this.prisma,
      d,
      'SENT',
      { kind: 'transport_handoff', attempt },
      {
        where: this.staleSentWhere(d),
        data: {
          attempts: attempt,
          deliveryMode: gate.mode,
          routeId: route.id,
          destinationFingerprint: route.destinationFingerprint,
          destinationMasked: route.destinationMasked,
          payloadSha256: createHash('sha256').update(xml).digest('hex'),
          payloadBytes: Buffer.byteLength(xml, 'utf8'),
        },
      },
    );
    // Another attempt is in flight (or just finished) — let the outbox retry later.
    if (!claimed) throw new Error('delivery_in_flight');
    const sent = { id: d.id, tenantId: d.tenantId, status: 'SENT' as const };

    const live = gate.mode === 'live';
    const transport: LeadDeliveryTransport =
      gate.transport === 'smtp' ? this.smtp : this.sink;
    let receipt: AcceptedReceipt;
    try {
      const r = await this.sendWithinDeadline(env.sendDeadlineMs, () =>
        transport.send(
          {
            deliveryId: d.id,
            tenantId: d.tenantId,
            routeId: route.id,
            routeEnvironment: route.environment,
            correlationId: d.correlationId,
            // Stable across retries so a receiver can de-duplicate an at-least-once resend.
            messageId: `<lead-delivery.${d.id}@${destinationDomain(env.fromAddress) || 'amqur.example.invalid'}>`,
            from: env.fromAddress,
            to: destination,
            subject: `New lead amqur-lead-${lead.id}`,
            xml,
            format: route.format,
            date: new Date(),
          },
          { live },
        ),
      );
      if (!r.accepted || !r.providerMessageId)
        throw new LeadTransportError('transport_not_accepted', true);
      receipt = { ...r, providerMessageId: r.providerMessageId };
    } catch (e: unknown) {
      // ONLY a failure of the transport hand-off itself lands here. Nothing below this block
      // (recording the acknowledgement) may ever mark the row FAILED or cause a re-send.
      const err =
        e instanceof LeadTransportError
          ? e
          : e instanceof UnsafeHeaderValueError
            ? new LeadTransportError('unsafe_header_value', false)
            : new LeadTransportError('transport_error', true);
      if (!err.retryable)
        return this.dead(
          sent,
          { kind: 'transport_error', code: err.code, retryable: false },
          err.code,
        );
      if (meta.attempts >= OUTBOX_MAX_ATTEMPTS)
        return this.dead(
          sent,
          { kind: 'attempts_exhausted', code: err.code },
          err.code,
        );
      await this.apply(
        this.prisma,
        sent,
        'FAILED',
        { kind: 'transport_error', code: err.code, retryable: true },
        {
          data: { lastErrorCode: err.code, lastErrorAt: new Date() },
          reasonCode: err.code,
        },
      );
      this.logger.warn(
        `lead delivery ${d.id} FAILED (retryable) code=${err.code} attempt=${attempt}`,
      );
      // Code only — never a provider message that could echo an address.
      throw new Error(err.code);
    }
    return this.recordAccepted(sent, receipt);
  }

  /**
   * Backstop for the hard send deadline, whatever the transport: the attempt is failed
   * (retryable) at the deadline even if a transport ignores its own. The SMTP transport enforces
   * the same deadline itself by aborting the connection.
   */
  async sendWithinDeadline<T>(
    deadlineMs: number,
    send: () => Promise<T>,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      // Slightly after the transport's own abort so its (more specific) outcome wins.
      timer = setTimeout(
        () => reject(new LeadTransportError(SEND_DEADLINE_CODE, true)),
        deadlineMs + 250,
      );
    });
    try {
      return await Promise.race([send(), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  // ───────────────────────────────────────── recording an acknowledgement

  /** A receipt for a SENT row that was accepted but not yet recorded as ACCEPTED, if any. */
  private pendingReceipt(d: LeadDelivery): AcceptedReceipt | null {
    if (d.status !== 'SENT') return null;
    const remembered = this.unrecordedReceipts.get(d.id);
    if (remembered) return remembered;
    if (
      d.lastErrorCode === ACCEPT_RECORD_PENDING &&
      d.providerName &&
      d.providerMessageId
    )
      return {
        accepted: true,
        providerName: d.providerName,
        providerMessageId: d.providerMessageId,
        rawStatus: d.providerRawStatus || 'no_status',
        at: d.acceptedAt ?? new Date(),
      };
    return null;
  }

  /**
   * The transport has ACCEPTED. From here on the row is never marked FAILED and never re-sent:
   *  1. write ACCEPTED (+ history) in one transaction, retried a few times;
   *  2. a lost compare-and-set is resolved explicitly against the row's current state;
   *  3. if the write still fails, store the receipt on the SENT row with the distinct code
   *     `accepted_record_pending` (one statement) and let the outbox retry FINALISE it;
   *  4. if even that fails, remember the receipt in this process for the next attempt.
   */
  private async recordAccepted(
    sent: Pick<LeadDelivery, 'id' | 'tenantId'>,
    receipt: AcceptedReceipt,
  ): Promise<OutboxHandlerResult> {
    const row = { id: sent.id, tenantId: sent.tenantId };
    const receiptData = {
      providerName: receipt.providerName,
      providerMessageId: receipt.providerMessageId,
      providerRawStatus: receipt.rawStatus,
      acceptedAt: receipt.at,
    };
    const evidence = {
      providerName: receipt.providerName,
      providerMessageId: receipt.providerMessageId,
      rawStatus: receipt.rawStatus,
    };
    for (let i = 1; i <= ACCEPT_WRITE_ATTEMPTS; i += 1) {
      try {
        const note = await this.prisma.$transaction(async (tx) => {
          const moved = await this.apply(
            tx,
            { ...row, status: 'SENT' },
            'ACCEPTED',
            { kind: 'transport_receipt', ...evidence },
            { data: { ...receiptData, lastErrorCode: null } },
          );
          if (moved) return `accepted:${receipt.providerName}`;
          // Lost compare-and-set: the row is no longer SENT. Decide from what it is NOW.
          const cur = await tx.leadDelivery.findFirst({
            where: row,
            select: { status: true },
          });
          if (!cur) return 'accepted:delivery_row_gone';
          if (isAcknowledged(cur.status)) return 'accepted:already_recorded';
          if (cur.status === 'FAILED' || cur.status === 'DEAD') {
            // Another attempt marked it failed while this send was being acknowledged.
            const late = await this.apply(
              tx,
              { ...row, status: cur.status },
              'ACCEPTED',
              { kind: 'late_transport_receipt', ...evidence },
              {
                data: { ...receiptData, lastErrorCode: null },
                reasonCode: 'late_transport_receipt',
              },
            );
            if (late) return `accepted_late:${receipt.providerName}`;
            throw new Error('accept_cas_lost_again');
          }
          // QUEUED / BLOCKED / re-claimed: keep the truth in the history; never drop it.
          await tx.leadDeliveryEvent.create({
            data: {
              tenantId: row.tenantId,
              deliveryId: row.id,
              fromStatus: cur.status,
              toStatus: cur.status,
              reasonCode: 'accepted_receipt_unapplied',
              evidence: {
                kind: 'late_transport_receipt',
                ...evidence,
              } as Prisma.InputJsonValue,
            },
          });
          this.metrics.increment('adf.delivery.accept_cas_lost');
          this.logger.error(
            `lead delivery ${row.id} accepted by transport but row is ${cur.status}; receipt kept in history`,
          );
          return `accepted_unapplied:${cur.status.toLowerCase()}`;
        });
        this.unrecordedReceipts.delete(row.id);
        this.logger.log(
          `lead delivery ${row.id} ACCEPTED provider=${receipt.providerName} note=${note}`,
        );
        // The acknowledgement is committed. A listener failure can never undo or repeat it.
        for (const listener of this.acceptedListeners)
          await listener(row).catch(() => undefined);
        return { note };
      } catch {
        if (i < ACCEPT_WRITE_ATTEMPTS)
          await new Promise((r) => setTimeout(r, ACCEPT_WRITE_BACKOFF_MS * i));
      }
    }
    // The acknowledgement could not be committed. Do NOT fail the row and do NOT re-send.
    this.metrics.increment('adf.delivery.accept_record_pending');
    this.unrecordedReceipts.set(row.id, receipt);
    try {
      await this.prisma.leadDelivery.updateMany({
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
        `lead delivery ${row.id} accepted; receipt could not be stored yet (kept in memory)`,
      );
    }
    this.logger.error(
      `lead delivery ${row.id} accepted by transport; ACCEPTED record pending`,
    );
    // Retry the OUTBOX event (not the send): the next attempt finalises from the stored receipt.
    throw new Error(ACCEPT_RECORD_PENDING);
  }

  // ───────────────────────────────────────── operator API

  private scopeWhere(scope: { tenantId: string; locationId: string | null }) {
    return {
      tenantId: scope.tenantId,
      ...(scope.locationId ? { locationId: scope.locationId } : {}),
    };
  }

  list(
    scope: { tenantId: string; locationId: string | null },
    filter: { status?: string; take?: number } = {},
  ) {
    const status = Object.values(LeadDeliveryStatus).includes(
      filter.status as LeadDeliveryStatus,
    )
      ? (filter.status as LeadDeliveryStatus)
      : undefined;
    if (filter.status && !status)
      throw new BadRequestException('Unknown status filter');
    return this.prisma.leadDelivery.findMany({
      where: { ...this.scopeWhere(scope), ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(filter.take ?? 100, 1), 200),
      select: DELIVERY_SELECT,
    });
  }

  async get(
    scope: { tenantId: string; locationId: string | null },
    id: string,
  ) {
    const d = await this.prisma.leadDelivery.findFirst({
      where: { id, ...this.scopeWhere(scope) },
      select: {
        ...DELIVERY_SELECT,
        events: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            fromStatus: true,
            toStatus: true,
            reasonCode: true,
            evidence: true,
            actor: true,
            createdAt: true,
          },
        },
        // R8: appointment updates that follow this lead (ids, states and codes only).
        appointmentUpdates: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            appointmentId: true,
            state: true,
            status: true,
            reason: true,
            sandboxReceipt: true,
            deliveryMode: true,
            sentAt: true,
            acceptedAt: true,
            createdAt: true,
          },
        },
      },
    });
    if (!d) throw new NotFoundException('Lead delivery not found');
    return d;
  }

  private async owned(
    scope: { tenantId: string; locationId: string | null },
    id: string,
  ) {
    const d = await this.prisma.leadDelivery.findFirst({
      where: { id, ...this.scopeWhere(scope) },
    });
    if (!d) throw new NotFoundException('Lead delivery not found');
    return d;
  }

  /** Re-arm the SAME outbox event so there is only ever one in-flight job per delivery. */
  private async rearmOutbox(
    tx: Prisma.TransactionClient,
    d: LeadDelivery,
  ): Promise<void> {
    const rearmed = d.outboxEventId
      ? await tx.outboxEvent.updateMany({
          where: {
            id: d.outboxEventId,
            tenantId: d.tenantId,
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
    if (rearmed.count !== 1) {
      if (d.outboxEventId) {
        const still = await tx.outboxEvent.findFirst({
          where: { id: d.outboxEventId, tenantId: d.tenantId },
          select: { id: true },
        });
        if (still) throw new ConflictException('delivery_in_flight');
      }
      const ev = await this.outbox.enqueue({
        tenantId: d.tenantId,
        topic: LEAD_DELIVERY_TOPIC,
        idempotencyKey: `${d.idempotencyKey}:replay:${d.replayCount + 1}`,
        payload: { deliveryId: d.id },
        tx,
      });
      await tx.leadDelivery.update({
        where: { id: d.id },
        data: { outboxEventId: ev.id },
      });
    }
  }

  /**
   * A row acknowledged by a SANDBOX transport does not count as acknowledged once the
   * environment is live. Queue it again (history keeps the sandbox acknowledgement); every live
   * gate is then evaluated as for any other delivery. Returns true when the row was re-queued.
   */
  private async supersedeSandboxAck(
    d: LeadDelivery,
    actor: string,
  ): Promise<boolean> {
    if (!isAcknowledged(d.status)) return false;
    if (acknowledgementCountsForMode(d.deliveryMode, readLeadDeliveryEnv()))
      return false;
    return this.prisma.$transaction(async (tx) => {
      const moved = await this.apply(
        tx,
        d,
        'QUEUED',
        { kind: 'sandbox_ack_superseded', actor },
        {
          actor,
          // Receipt columns describe the SANDBOX hand-off only; clear them with the status.
          data: {
            providerName: null,
            providerMessageId: null,
            providerRawStatus: null,
            acceptedAt: null,
            crmRecordRef: null,
            blockedReason: null,
          },
        },
      );
      if (!moved) return false;
      await this.rearmOutbox(tx, d);
      return true;
    });
  }

  /**
   * Re-queue BLOCKED rows whose block came from the ENVIRONMENT (`sandbox_in_production`,
   * `send_disabled`) once the environment no longer blocks them. Does nothing — not even a
   * query — while sending is globally disabled. Every other gate is re-checked by the handler.
   */
  async reevaluateBlocked(
    opts: { limit?: number; tenantId?: string } = {},
  ): Promise<number> {
    const limit = opts.limit ?? 200;
    const env = readLeadDeliveryEnv();
    const reasons = REEVALUABLE_BLOCK_REASONS.filter(
      (r) => !blockReasonStillApplies(r, env),
    );
    if (!env.sendEnabled || reasons.length === 0) return 0;
    const rows = await this.prisma.leadDelivery.findMany({
      where: {
        status: 'BLOCKED',
        blockedReason: { in: [...reasons] },
        ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
      },
      orderBy: { createdAt: 'asc' },
      take: Math.min(Math.max(limit, 1), 500),
    });
    let requeued = 0;
    for (const d of rows) {
      try {
        const moved = await this.prisma.$transaction(async (tx) => {
          const ok = await this.apply(
            tx,
            d,
            'QUEUED',
            { kind: 'gate_reevaluation', reason: d.blockedReason ?? 'unknown' },
            { data: { blockedReason: null } },
          );
          if (ok) await this.rearmOutbox(tx, d);
          return ok;
        });
        if (moved) requeued += 1;
      } catch {
        // In flight or changed concurrently — the next sweep picks it up.
      }
    }
    if (requeued > 0) {
      this.metrics.increment('adf.delivery.reevaluated', requeued);
      this.logger.log(
        `lead delivery re-evaluation re-queued ${requeued} row(s)`,
      );
    }
    return requeued;
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async reevaluateBlockedTick(): Promise<void> {
    if (process.env.OUTBOX_PROCESSOR_ENABLED === 'false') return;
    try {
      await this.reevaluateBlocked();
    } catch {
      this.logger.warn('lead delivery re-evaluation sweep failed');
    }
  }

  /** Re-queue a FAILED / DEAD / BLOCKED delivery (audited). Never re-sends an acknowledged one. */
  async replay(
    scope: { tenantId: string; locationId: string | null },
    id: string,
    userId: string,
  ) {
    const d = await this.owned(scope, id);
    if (await this.supersedeSandboxAck(d, userId)) {
      await this.prisma.auditLog.create({
        data: {
          tenantId: d.tenantId,
          userId,
          action: 'lead_delivery.replay',
          resource: 'lead_delivery',
          resourceId: d.id,
          metadata: {
            fromStatus: d.status,
            department: d.department,
            sandboxAckSuperseded: true,
          },
        },
      });
      return this.get(scope, id);
    }
    if (!REPLAYABLE_STATUSES.has(d.status))
      throw new ConflictException(`not_replayable:${d.status}`);
    await this.prisma.$transaction(async (tx) => {
      const moved = await this.apply(
        tx,
        d,
        'QUEUED',
        { kind: 'operator_replay', actor: userId },
        {
          actor: userId,
          data: { replayCount: { increment: 1 }, blockedReason: null },
        },
      );
      if (!moved) throw new ConflictException('delivery_changed_concurrently');
      await this.rearmOutbox(tx, d);
      await tx.auditLog.create({
        data: {
          tenantId: d.tenantId,
          userId,
          action: 'lead_delivery.replay',
          resource: 'lead_delivery',
          resourceId: d.id,
          metadata: { fromStatus: d.status, department: d.department },
        },
      });
    });
    return this.get(scope, id);
  }

  /**
   * Record an explicit reconciliation result. CRM_MATCHED requires a CRM record reference; a
   * parser rejection lands in the distinct CRM_REJECTED state. Audited.
   */
  async reconcile(
    scope: { tenantId: string; locationId: string | null },
    id: string,
    input: { result: ReconcileResult; crmRecordRef?: string; note?: string },
    userId: string,
  ) {
    const d = await this.owned(scope, id);
    const ref = input.crmRecordRef?.trim();
    if (ref !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(ref))
      throw new BadRequestException(
        'crmRecordRef must be an opaque CRM record id',
      );
    if (input.result === 'CRM_MATCHED' && !ref)
      throw new BadRequestException('CRM_MATCHED requires crmRecordRef');
    const kind = {
      CRM_PARSED: 'PARSED',
      CRM_MATCHED: 'MATCHED',
      CRM_REJECTED: 'REJECTED',
    }[input.result] as 'PARSED' | 'MATCHED' | 'REJECTED';
    await this.prisma.$transaction(async (tx) => {
      const moved = await this.apply(
        tx,
        d,
        input.result,
        {
          kind: 'crm_reconciliation',
          result: kind,
          crmRecordRef: ref ?? null,
          actor: userId,
        },
        {
          actor: userId,
          data: ref ? { crmRecordRef: ref } : {},
        },
      );
      await tx.auditLog.create({
        data: {
          tenantId: d.tenantId,
          userId,
          action: 'lead_delivery.reconciled',
          resource: 'lead_delivery',
          resourceId: d.id,
          metadata: {
            result: input.result,
            applied: moved,
            fromStatus: d.status,
            crmRecordRef: ref ?? null,
            // Free text typed by staff: contact details are redacted before the audit row is
            // written (audit rows are append-only).
            note: input.note ? redactForLog(input.note).slice(0, 300) : null,
          },
        },
      });
    });
    return this.get(scope, id);
  }
}
