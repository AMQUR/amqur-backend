import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
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
  ADF_FEATURE_FLAG,
  checkDestinationForMode,
  departmentForLeadSource,
  evaluateSendGates,
  leadDeliveryIdempotencyKey,
  readLeadDeliveryEnv,
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
} from './transports/lead-delivery-transport';
import { SandboxSinkTransport } from './transports/sandbox-sink.transport';
import { SmtpLeadTransport } from './transports/smtp.transport';

export const LEAD_DELIVERY_TOPIC = 'lead.delivery.adf';
/** A SENT row older than this with no outcome is treated as a crashed attempt and retried. */
export const SENT_STALE_MS = 90_000;

type Db = Prisma.TransactionClient | PrismaService;

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
    this.processor.registerHandler(LEAD_DELIVERY_TOPIC, (p, m) => {
      if (typeof p.deliveryId !== 'string')
        throw new PermanentOutboxError('bad_payload');
      return this.process(p.deliveryId, m);
    });
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
      select: { id: true },
    });
    if (existing) return { status: 'exists', deliveryId: existing.id };

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

  private async block(
    d: LeadDelivery,
    reason: string,
  ): Promise<OutboxHandlerResult> {
    await this.apply(
      this.prisma,
      d,
      'BLOCKED',
      { kind: 'gate_blocked', reason },
      { data: { blockedReason: reason }, reasonCode: reason },
    );
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

  // ───────────────────────────────────────── outbox handler

  async process(
    deliveryId: string,
    meta: { id: string; tenantId: string; attempts: number },
  ): Promise<OutboxHandlerResult> {
    const d = await this.prisma.leadDelivery.findFirst({
      where: { id: deliveryId, tenantId: meta.tenantId },
    });
    if (!d) throw new PermanentOutboxError('delivery_not_found');
    // At most one accepted send: an acknowledged delivery is never handed to a transport again.
    if (isAcknowledged(d.status)) return { note: 'already_acknowledged' };
    if (d.status === 'DEAD' || d.status === 'BLOCKED')
      return { note: `not_replayed:${d.status.toLowerCase()}` };

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
    const flags = await this.flags.resolve(lead.tenantId, lead.locationId);
    // Routing is keyed strictly by the LEAD's own tenant + location + department.
    const route = await this.routes.findForLead(
      lead.tenantId,
      lead.locationId,
      d.department,
    );
    const gate = evaluateSendGates({
      env,
      flagEnabled: flags[ADF_FEATURE_FLAG] === true,
      lead: {
        tenantId: lead.tenantId,
        locationId: lead.locationId,
        hasContactMethod: Boolean(lead.email || lead.phone),
        optedOut: lead.optOutAt !== null,
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

    // FINAL GUARD, immediately before transport: the route is the lead's own tenant + rooftop.
    if (
      route.tenantId !== lead.tenantId ||
      route.tenantId !== d.tenantId ||
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
        where:
          d.status === 'SENT'
            ? { updatedAt: { lt: new Date(Date.now() - SENT_STALE_MS) } }
            : undefined,
        data: {
          attempts: attempt,
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
    try {
      const receipt = await transport.send(
        {
          deliveryId: d.id,
          tenantId: d.tenantId,
          routeId: route.id,
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
      );
      if (!receipt.accepted || !receipt.providerMessageId)
        throw new LeadTransportError('transport_not_accepted', true);
      await this.apply(
        this.prisma,
        sent,
        'ACCEPTED',
        {
          kind: 'transport_receipt',
          providerName: receipt.providerName,
          providerMessageId: receipt.providerMessageId,
          rawStatus: receipt.rawStatus,
        },
        {
          data: {
            providerName: receipt.providerName,
            providerMessageId: receipt.providerMessageId,
            providerRawStatus: receipt.rawStatus,
            acceptedAt: receipt.at,
            lastErrorCode: null,
          },
        },
      );
      this.logger.log(
        `lead delivery ${d.id} ACCEPTED provider=${receipt.providerName} mode=${gate.mode}`,
      );
      return { note: `accepted:${receipt.providerName}` };
    } catch (e: unknown) {
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

  /** Re-queue a FAILED / DEAD / BLOCKED delivery (audited). Never re-sends an acknowledged one. */
  async replay(
    scope: { tenantId: string; locationId: string | null },
    id: string,
    userId: string,
  ) {
    const d = await this.owned(scope, id);
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
      // Re-arm the SAME outbox event so there is only ever one in-flight job per delivery.
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
            note: input.note?.slice(0, 300) ?? null,
          },
        },
      });
    });
    return this.get(scope, id);
  }
}
