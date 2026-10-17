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
};

export interface ServiceSchedulingProviderAdapter {
  readonly providerId: string;
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
