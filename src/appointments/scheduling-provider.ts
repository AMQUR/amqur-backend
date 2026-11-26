/**
 * Provider-neutral scheduling contract (Tekion, Xtime, CDK, Google Calendar fallback…).
 * Business logic depends on THIS interface only — never on a vendor SDK.
 *
 * Outcome semantics are strict:
 *   confirmed   → provider returned a booking id AND confirmed the slot
 *   pending     → provider accepted the request but confirmation is asynchronous
 *   unavailable → provider says the slot is not bookable (offer alternatives)
 *   failed      → transport/auth/provider error (AMQUR keeps a REQUESTED record)
 * "AMQUR stored the request" is NEVER reported as confirmed.
 *
 * A `create()` that throws or times out is NOT a `failed` outcome: the provider may still have
 * booked. AMQUR records it as UNKNOWN and compensates by idempotency key (see the interface).
 */
export type SchedulingDepartment =
  | 'SALES'
  | 'SERVICE'
  | 'PARTS'
  | 'FINANCE'
  | 'TEST_DRIVE';

export type SchedulingCapabilities = {
  availabilityRead: boolean;
  create: boolean;
  update: boolean;
  cancel: boolean;
  serviceTypes: boolean;
  transportationOptions: boolean;
};

export type AvailabilitySlot = {
  startUtc: string;
  endUtc: string;
  advisorId?: string;
  providerSlotId?: string;
};

export type SchedulingOutcome =
  | {
      kind: 'confirmed';
      externalId: string;
      providerStatus: string;
      scheduledAtUtc: string;
      providerRequestId?: string;
      /** Verbatim provider status for the receipt, when different from providerStatus. */
      rawStatus?: string;
    }
  | {
      kind: 'pending';
      externalId?: string;
      providerStatus: string;
      providerRequestId?: string;
    }
  | { kind: 'unavailable'; reason: string; alternatives?: AvailabilitySlot[] }
  | { kind: 'failed'; errorCode: string; retryable: boolean };

export type SchedulingContext = {
  tenantId: string;
  locationId?: string | null;
  connectionId: string;
  mode: 'sandbox' | 'production';
  timeoutMs: number;
  idempotencyKey: string;
  correlationId: string;
  /** Clock override for deterministic tests (defaults to the wall clock). */
  now?: Date;
};

export interface ServiceSchedulingProviderAdapter {
  readonly providerId: string;
  /** Customer-facing scheduler name shown on a confirmation card. */
  readonly displayName?: string;
  /** True for demo/sandbox schedulers: every receipt and card is labelled sandbox. */
  readonly sandbox?: boolean;
  capabilities(): SchedulingCapabilities;
  getAvailability?(
    ctx: SchedulingContext,
    q: {
      department: SchedulingDepartment;
      fromUtc: string;
      toUtc: string;
      serviceType?: string;
    },
  ): Promise<AvailabilitySlot[]>;
  create?(
    ctx: SchedulingContext,
    req: {
      department: SchedulingDepartment;
      startUtc: string;
      durationMinutes: number;
      /** Provider slot id when the customer picked an offered slot. */
      providerSlotId?: string;
      customer: {
        name?: string | null;
        phone?: string | null;
        email?: string | null;
      };
      vin?: string | null;
      serviceType?: string | null;
      notes?: string | null;
    },
  ): Promise<SchedulingOutcome>;
  /**
   * IDEMPOTENCY CONTRACT — mandatory for every adapter whose `capabilities().create` is true
   * (the registry refuses to register one that lacks either method below):
   *
   *  - `create()` MUST honour `ctx.idempotencyKey`: a repeat with the same key returns the SAME
   *    booking and never makes a second one, even when the first response was lost;
   *  - `findByIdempotencyKey()` returns the booking made under `ctx.idempotencyKey` (`confirmed`
   *    or `pending`), or `null` when the provider holds none. It must not create anything;
   *  - `cancelByIdempotencyKey()` cancels that booking; "nothing to cancel" is a success with
   *    `cancelled: false`.
   *
   * AMQUR uses the pair to compensate when a `create()` outcome is unknown (timeout, thrown
   * error, or a confirmation that could not be recorded): the booking is either reconciled to
   * its one appointment or cancelled — see AppointmentService.reconcileProviderBooking.
   */
  findByIdempotencyKey?(
    ctx: SchedulingContext,
  ): Promise<Extract<
    SchedulingOutcome,
    { kind: 'confirmed' | 'pending' }
  > | null>;
  cancelByIdempotencyKey?(
    ctx: SchedulingContext,
    reason?: string,
  ): Promise<{ cancelled: boolean; externalId?: string }>;
  reschedule?(
    ctx: SchedulingContext,
    externalId: string,
    startUtc: string,
  ): Promise<SchedulingOutcome>;
  cancel?(
    ctx: SchedulingContext,
    externalId: string,
    reason?: string,
  ): Promise<SchedulingOutcome>;
}
