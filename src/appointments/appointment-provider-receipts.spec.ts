import { Prisma } from '@prisma/client';
import {
  APPOINTMENT_RECONCILE_TOPIC,
  AppointmentService,
  providerErrorCode,
} from './appointment.service';
import { AppointmentReconcileService } from './appointment-reconcile.service';
import { PermanentOutboxError } from '../integrations/core/outbox-processor.service';
import {
  SandboxSchedulingAdapter,
  sandboxSlots,
  sandboxTakenSlotStart,
} from './sandbox-scheduling.adapter';
import {
  ResolvedScheduler,
  SchedulingProviderRegistry,
} from './scheduling-provider.registry';
import type {
  SchedulingOutcome,
  ServiceSchedulingProviderAdapter,
} from './scheduling-provider';

/** Minimal in-memory Prisma double with the two unique constraints that matter here. */
function fakeDb() {
  const appointments: Array<Record<string, any>> = [];
  const receipts: Array<Record<string, any>> = [];
  const p2002 = () =>
    new Prisma.PrismaClientKnownRequestError('unique', {
      code: 'P2002',
      clientVersion: 'test',
    });
  let n = 0;
  const appointment = {
    findUnique: jest.fn(async ({ where }: any) => {
      const k = where.tenantId_idempotencyKey;
      return (
        appointments.find(
          (a) =>
            a.tenantId === k.tenantId && a.idempotencyKey === k.idempotencyKey,
        ) ?? null
      );
    }),
    create: jest.fn(async ({ data }: any) => {
      if (
        appointments.some(
          (a) =>
            a.tenantId === data.tenantId &&
            a.idempotencyKey === data.idempotencyKey,
        )
      )
        throw p2002();
      const row = { id: `appt-${(n += 1)}`, updatedAt: new Date(), ...data };
      appointments.push(row);
      return row;
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const row = appointments.find((a) => a.id === where.id)!;
      Object.assign(row, data);
      return row;
    }),
    findFirst: jest.fn(async ({ where }: any) => {
      return (
        appointments.find(
          (a) => a.id === where.id && a.tenantId === where.tenantId,
        ) ?? null
      );
    }),
  };
  const outbox: Array<Record<string, any>> = [];
  const appointmentProviderReceipt = {
    create: jest.fn(async ({ data }: any) => {
      if (
        data.providerRef &&
        receipts.some(
          (r) =>
            r.tenantId === data.tenantId &&
            r.provider === data.provider &&
            r.providerRef === data.providerRef,
        )
      )
        throw p2002();
      const row = {
        id: `rcpt-${receipts.length + 1}`,
        receivedAt: new Date(),
        ...data,
      };
      receipts.push(row);
      return row;
    }),
    findFirst: jest.fn(async ({ where }: any) => {
      return (
        receipts.find(
          (r) =>
            r.appointmentId === where.appointmentId &&
            r.status === where.status,
        ) ?? null
      );
    }),
  };
  const db: any = {
    appointment,
    appointmentProviderReceipt,
    outboxEvent: {
      create: jest.fn(async ({ data }: any) => {
        outbox.push(data);
        return data;
      }),
    },
    escalation: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
    },
    analyticsEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  // Like a real transaction: a failure rolls back what the callback wrote.
  db.$transaction = jest.fn(async (fn: any) => {
    const snapshot = {
      a: appointments.map((x) => ({ ...x })),
      r: receipts.length,
      o: outbox.length,
    };
    try {
      return await fn(db);
    } catch (e) {
      appointments.splice(0, appointments.length, ...snapshot.a);
      receipts.length = snapshot.r;
      outbox.length = snapshot.o;
      throw e;
    }
  });
  return { db, appointments, receipts, outbox };
}

const now = new Date('2026-10-13T15:00:00.000Z');
const slotStart = sandboxSlots(now)[0].startUtc;

function make(adapter: ServiceSchedulingProviderAdapter | null) {
  const f = fakeDb();
  const scheduler: ResolvedScheduler | null = adapter
    ? {
        adapter,
        connectionId: 'conn-1',
        provider: adapter.providerId,
        mode: 'sandbox',
        sandbox: adapter.sandbox === true,
        displayName: adapter.displayName ?? adapter.providerId,
      }
    : null;
  const registry = {
    resolve: jest.fn().mockResolvedValue(scheduler),
    adapterFor: jest.fn().mockReturnValue(adapter ?? undefined),
    context: jest.fn(
      (_r, tenantId, locationId, idempotencyKey, correlationId, n) => ({
        tenantId,
        locationId,
        connectionId: 'conn-1',
        mode: 'sandbox',
        timeoutMs: 200,
        idempotencyKey,
        correlationId,
        now: n,
      }),
    ),
  };
  const breaker = { recordSuccess: jest.fn(), recordFailure: jest.fn() };
  const svc = new AppointmentService(
    f.db as never,
    { getProfile: jest.fn().mockResolvedValue(null) } as never,
    registry as never,
    breaker as never,
    { increment: jest.fn() } as never,
  );
  const book = (over: Record<string, unknown> = {}) =>
    svc.request({
      tenantId: 't1',
      locationId: 'l1',
      conversationId: 'conv-1',
      type: 'TEST_DRIVE',
      when: {
        date: { year: 2026, month: 10, day: 14 },
        time: 600,
        phrase: 'selected slot',
      },
      idempotencyKey: 'slot:conv-1:pk_1:sl_1',
      providerSlot: { startUtc: slotStart, providerSlotId: `sbx:${slotStart}` },
      source: 'chat',
      now,
      ...over,
    } as never);
  return { ...f, svc, registry, book };
}

const stub = (
  outcome: SchedulingOutcome | (() => Promise<SchedulingOutcome>),
) =>
  ({
    providerId: 'STUB',
    displayName: 'Stub scheduler',
    capabilities: () => ({
      availabilityRead: true,
      create: true,
      update: false,
      cancel: false,
      serviceTypes: false,
      transportationOptions: false,
    }),
    create: jest.fn(
      typeof outcome === 'function' ? outcome : async () => outcome,
    ),
  }) as unknown as ServiceSchedulingProviderAdapter;

describe('AppointmentService — provider receipts', () => {
  it('without a scheduler a request stays REQUESTED and writes no receipt', async () => {
    const m = make(null);
    const r = await m.book({
      providerSlot: undefined,
      idempotencyKey: undefined,
    });
    expect(r).toMatchObject({ status: 'saved', outcome: 'requested' });
    expect(r).not.toHaveProperty('provider');
    expect(m.appointments[0].status).toBe('REQUESTED');
    expect(m.receipts).toEqual([]);
  });

  it('a provider confirmation writes one CONFIRMED receipt and syncs provider columns', async () => {
    const m = make(new SandboxSchedulingAdapter());
    const r = await m.book();
    if (r.status !== 'saved') throw new Error('expected saved');
    expect(r.outcome).toBe('confirmed');
    expect(r.provider).toEqual({
      ref: expect.stringMatching(/^SBX-/),
      name: 'Sandbox scheduler',
      sandbox: true,
      startsAt: slotStart,
    });
    expect(m.receipts).toHaveLength(1);
    expect(m.receipts[0]).toMatchObject({
      tenantId: 't1',
      appointmentId: r.appointment.id,
      provider: 'MOCK',
      providerRef: r.provider!.ref,
      status: 'CONFIRMED',
      rawStatus: 'SANDBOX_CONFIRMED',
      idempotencyKey: 'slot:conv-1:pk_1:sl_1',
      sandbox: true,
    });
    expect(m.receipts[0].confirmedStart.toISOString()).toBe(slotStart);
    expect(m.appointments[0]).toMatchObject({
      status: 'CONFIRMED',
      provider: 'MOCK',
      externalProviderId: r.provider!.ref,
      providerStatus: 'CONFIRMED',
      availabilityVerified: true,
    });
    expect(m.appointments[0].scheduledAt.toISOString()).toBe(slotStart);
    // the adapter got the provider slot and the per-selection idempotency key
    expect(m.registry.resolve).toHaveBeenCalledWith('t1', 'l1', 'TEST_DRIVE');

    // idempotent replay: same appointment, provider details read back from the receipt
    const again = await m.book();
    expect(again).toMatchObject({
      status: 'saved',
      outcome: 'confirmed',
      provider: r.provider,
    });
    expect(m.appointments).toHaveLength(1);
    expect(m.receipts).toHaveLength(1);
  });

  it('a provider rejection is never a confirmation; a retry gets its own key', async () => {
    const m = make(new SandboxSchedulingAdapter());
    const taken = sandboxTakenSlotStart(now);
    const over = { providerSlot: { startUtc: taken } };
    const r = await m.book(over);
    expect(r).toMatchObject({ status: 'rejected', code: 'unavailable' });
    expect(m.appointments[0]).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'provider_unavailable:slot_taken',
    });
    expect(
      m.receipts.map((x) => [x.status, x.providerRef, x.rawStatus]),
    ).toEqual([['UNAVAILABLE', null, 'slot_taken']]);
    // same selection again: a new attempt (no unique-key crash), rejected again
    expect(await m.book(over)).toMatchObject({ status: 'rejected' });
    expect(await m.book(over)).toMatchObject({ status: 'rejected' });
    expect(m.appointments.map((a) => a.status)).toEqual([
      'CANCELLED',
      'CANCELLED',
      'CANCELLED',
    ]);
    expect(new Set(m.appointments.map((a) => a.idempotencyKey)).size).toBe(3);
    expect(m.receipts).toHaveLength(3);
  });

  it('a provider-REPORTED failure keeps the request REQUESTED with a FAILED receipt', async () => {
    const m = make(
      stub({ kind: 'failed', errorCode: 'slot_service_down', retryable: true }),
    );
    const r = await m.book();
    expect(r).toMatchObject({
      status: 'saved',
      outcome: 'requested',
      providerFailure: 'slot_service_down',
    });
    expect(r).not.toHaveProperty('provider');
    expect(m.appointments[0].status).toBe('REQUESTED');
    expect(m.receipts.map((x) => [x.status, x.rawStatus, x.sandbox])).toEqual([
      ['FAILED', 'slot_service_down', true],
    ]);
    expect(m.outbox.map((o) => o.topic)).toEqual(['appointment.requested']);
  });

  // R6: a timeout is NOT a provider failure — the provider may still have booked.
  it('a provider timeout keeps the request REQUESTED with an UNKNOWN receipt and queues the compensation job', async () => {
    const m = make(stub(() => new Promise<SchedulingOutcome>(() => undefined)));
    const r = await m.book();
    expect(r).toMatchObject({
      status: 'saved',
      outcome: 'requested',
      providerFailure: 'provider_timeout',
    });
    expect(r).not.toHaveProperty('provider');
    expect(m.appointments[0]).toMatchObject({
      status: 'REQUESTED',
      providerStatus: 'UNKNOWN:provider_timeout',
    });
    expect(m.receipts.map((x) => [x.status, x.rawStatus, x.sandbox])).toEqual([
      ['UNKNOWN', 'provider_timeout', true],
    ]);
    const job = m.outbox.find((o) => o.topic === APPOINTMENT_RECONCILE_TOPIC)!;
    expect(job).toMatchObject({
      tenantId: 't1',
      idempotencyKey: `${APPOINTMENT_RECONCILE_TOPIC}:slot:conv-1:pk_1:sl_1`,
      payload: {
        appointmentId: m.appointments[0].id,
        provider: 'STUB',
        connectionId: 'conn-1',
        bookingIdempotencyKey: 'slot:conv-1:pk_1:sl_1',
        reason: 'provider_timeout',
      },
    });
  });

  // R15: adapter exception text can echo customer data — only a short code is stored.
  it('an adapter exception is stored as a short code, never its text', async () => {
    const boom = Object.assign(
      new Error(
        '422 customer pat.rivera@example.invalid (312) 555-0142 rejected',
      ),
      { code: 'E_VALIDATION' },
    );
    const m = make(stub(() => Promise.reject(boom)));
    const r = await m.book();
    expect(r).toMatchObject({
      outcome: 'requested',
      providerFailure: 'provider_error_e_validation',
    });
    const stored = JSON.stringify([m.receipts, m.appointments, m.outbox]);
    expect(stored).not.toContain('example.invalid');
    expect(stored).not.toContain('555-0142');
    expect(m.receipts[0]).toMatchObject({
      status: 'UNKNOWN',
      rawStatus: 'provider_error_e_validation',
    });
    expect(m.appointments[0].providerStatus).toBe(
      'UNKNOWN:provider_error_e_validation',
    );
    expect(providerErrorCode(new Error('free text with a name'))).toBe(
      'provider_error',
    );
    expect(providerErrorCode({ code: 'has spaces & <tags>' })).toBe(
      'provider_error',
    );
    expect(providerErrorCode({ code: 503 })).toBe('provider_error_503');
  });

  it('a pending provider answer is PENDING_CONFIRMATION, not confirmed', async () => {
    const m = make(
      stub({ kind: 'pending', externalId: 'X-1', providerStatus: 'QUEUED' }),
    );
    const r = await m.book();
    expect(r).toMatchObject({ status: 'saved', outcome: 'pending' });
    expect(m.appointments[0].status).toBe('PENDING_CONFIRMATION');
    expect(m.receipts[0]).toMatchObject({
      status: 'PENDING',
      providerRef: 'X-1',
    });
  });

  it('a provider reference that already backs another appointment confirms nothing', async () => {
    const adapter = stub({
      kind: 'confirmed',
      externalId: 'DUP-1',
      providerStatus: 'BOOKED',
      scheduledAtUtc: slotStart,
    });
    const m = make(adapter);
    expect(await m.book()).toMatchObject({
      status: 'saved',
      outcome: 'confirmed',
    });
    const second = await m.book({
      conversationId: 'conv-2',
      idempotencyKey: 'slot:conv-2:pk_2:sl_2',
    });
    expect(second).toMatchObject({ status: 'rejected', code: 'unavailable' });
    expect(m.appointments.map((a) => a.status)).toEqual([
      'CONFIRMED',
      'CANCELLED',
    ]);
    expect(m.receipts.map((x) => x.status)).toEqual(['CONFIRMED', 'CONFLICT']);
    expect(m.receipts.filter((x) => x.status === 'CONFIRMED')).toHaveLength(1);
  });

  it('two concurrent identical selections create one appointment and one confirmation', async () => {
    const m = make(new SandboxSchedulingAdapter());
    const [a, b] = await Promise.all([m.book(), m.book()]);
    expect(a).toMatchObject({ status: 'saved', outcome: 'confirmed' });
    expect(b).toMatchObject({ status: 'saved', outcome: 'confirmed' });
    if (a.status !== 'saved' || b.status !== 'saved')
      throw new Error('unreachable');
    expect(a.appointment.id).toBe(b.appointment.id);
    expect(m.appointments).toHaveLength(1);
    expect(m.receipts.filter((x) => x.status === 'CONFIRMED')).toHaveLength(1);
  });

  it('a slot that is already in the past is refused before anything is written', async () => {
    const m = make(new SandboxSchedulingAdapter());
    const r = await m.book({
      providerSlot: { startUtc: '2026-10-13T14:00:00.000Z' },
    });
    expect(r).toMatchObject({ status: 'rejected', code: 'in_past' });
    expect(m.appointments).toEqual([]);
    expect(m.receipts).toEqual([]);
  });

  it('offerableSlots: null without an authorised scheduler; slots with one', async () => {
    expect(
      await make(null).svc.offerableSlots({
        tenantId: 't1',
        locationId: 'l1',
        type: 'SALES',
        now,
      }),
    ).toBeNull();
    // an adapter that cannot read availability is not a slot source
    expect(
      await make(
        stub({ kind: 'failed', errorCode: 'x', retryable: false }),
      ).svc.offerableSlots({
        tenantId: 't1',
        locationId: 'l1',
        type: 'SALES',
        now,
      }),
    ).toBeNull();
    const offer = await make(new SandboxSchedulingAdapter()).svc.offerableSlots(
      {
        tenantId: 't1',
        locationId: 'l1',
        type: 'SALES',
        now,
      },
    );
    expect(offer).toMatchObject({
      provider: 'MOCK',
      sandbox: true,
      connectionId: 'conn-1',
    });
    expect(offer!.slots).toHaveLength(16);
  });
});

describe('R6 — an unknown booking outcome is compensated (cancel-or-reconcile by idempotency key)', () => {
  /** A sandbox adapter whose answer arrives only after the caller has timed out. */
  const lateSandbox = () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const adapter = new SandboxSchedulingAdapter(async () => {
      await gate;
      return false;
    });
    const create = jest.spyOn(adapter, 'create');
    return { adapter, create, release };
  };
  const reconcileJob = (m: ReturnType<typeof make>) =>
    m.outbox.find((o) => o.topic === APPOINTMENT_RECONCILE_TOPIC)!;
  const runJob = (m: ReturnType<typeof make>) =>
    new AppointmentReconcileService(
      { registerHandler: jest.fn() } as never,
      m.svc,
    ).handle(reconcileJob(m).payload, { tenantId: 't1' });
  const ctx = {
    tenantId: 't1',
    locationId: 'l1',
    connectionId: 'conn-1',
    mode: 'sandbox' as const,
    timeoutMs: 200,
    idempotencyKey: 'slot:conv-1:pk_1:sl_1',
    correlationId: 'x',
    now,
  };

  it('late success after a timeout: the retry books nothing new, and the orphan is reconciled to exactly one appointment', async () => {
    const { adapter, create, release } = lateSandbox();
    const m = make(adapter);
    const first = await m.book(); // times out after 200 ms
    expect(first).toMatchObject({
      status: 'saved',
      outcome: 'requested',
      providerFailure: 'provider_timeout',
    });
    expect(m.receipts.map((r) => r.status)).toEqual(['UNKNOWN']);
    // …and now the provider's success arrives, too late for the caller.
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(await adapter.findByIdempotencyKey(ctx)).toMatchObject({
      kind: 'confirmed',
      scheduledAtUtc: slotStart,
    });

    // The customer (or the client) retries the very same selection: no second provider call,
    // no second appointment.
    const retry = await m.book();
    expect(retry).toMatchObject({ status: 'saved', outcome: 'requested' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(m.appointments).toHaveLength(1);

    // The compensation job reconciles the orphan booking to that one appointment.
    await expect(runJob(m)).resolves.toEqual({ note: 'reconciled_confirmed' });
    expect(m.appointments).toHaveLength(1);
    expect(m.appointments[0]).toMatchObject({
      status: 'CONFIRMED',
      provider: 'MOCK',
      availabilityVerified: true,
    });
    expect(m.appointments[0].externalProviderId).toMatch(/^SBX-/);
    expect(m.receipts.map((r) => r.status)).toEqual(['UNKNOWN', 'CONFIRMED']);
    expect(m.receipts[1]).toMatchObject({
      providerRef: m.appointments[0].externalProviderId,
      sandbox: true,
      idempotencyKey: 'slot:conv-1:pk_1:sl_1',
    });
    // At-least-once: running the job again changes nothing.
    await expect(runJob(m)).resolves.toEqual({ note: 'already_confirmed' });
    expect(m.receipts.filter((r) => r.status === 'CONFIRMED')).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('late success for a request the customer has since cancelled: the orphan is cancelled at the provider', async () => {
    const { adapter, release } = lateSandbox();
    const m = make(adapter);
    await m.book();
    release();
    await new Promise((r) => setTimeout(r, 20));
    m.appointments[0].status = 'CANCELLED';
    await expect(runJob(m)).resolves.toEqual({ note: 'orphan_cancelled' });
    expect(await adapter.findByIdempotencyKey(ctx)).toBeNull();
    expect(m.appointments[0].status).toBe('CANCELLED');
    expect(m.receipts.map((r) => [r.status, r.rawStatus])).toEqual([
      ['UNKNOWN', 'provider_timeout'],
      ['ORPHAN_CANCELLED', 'orphan_cancelled'],
    ]);
    // The slot is free again for another customer.
    const other = await adapter.create(
      { ...ctx, idempotencyKey: 'slot:conv-2:pk_9:sl_9' },
      { department: 'TEST_DRIVE', startUtc: slotStart },
    );
    expect(other.kind).toBe('confirmed');
  });

  it('timeout and the provider never booked: NOT_FOUND receipt, the request stays for staff', async () => {
    const m = make(new SandboxSchedulingAdapter());
    // Force the unknown outcome without the provider holding anything.
    jest
      .spyOn(m.registry.adapterFor() as SandboxSchedulingAdapter, 'create')
      .mockImplementation(
        () => new Promise<SchedulingOutcome>(() => undefined),
      );
    await m.book();
    await expect(runJob(m)).resolves.toEqual({ note: 'no_provider_booking' });
    expect(m.appointments[0]).toMatchObject({
      status: 'REQUESTED',
      providerStatus: 'RECONCILED:no_provider_booking',
    });
    expect(m.receipts.map((r) => r.status)).toEqual(['UNKNOWN', 'NOT_FOUND']);
  });

  it('the provider confirmed but the CONFIRMED receipt could not be persisted: never reported confirmed, compensation queued, then reconciled once', async () => {
    const adapter = new SandboxSchedulingAdapter();
    const m = make(adapter);
    // The first receipt insert (the CONFIRMED one) fails with a non-unique database error.
    const realCreate =
      m.db.appointmentProviderReceipt.create.getMockImplementation();
    m.db.appointmentProviderReceipt.create
      .mockImplementationOnce(async () => {
        throw new Error('connection reset');
      })
      .mockImplementation(realCreate);
    const r = await m.book();
    expect(r).toMatchObject({
      status: 'saved',
      outcome: 'requested',
      providerFailure: 'confirm_persist_failed',
    });
    expect(r).not.toHaveProperty('provider');
    expect(m.appointments[0]).toMatchObject({
      status: 'REQUESTED',
      providerStatus: 'UNKNOWN:confirm_persist_failed',
    });
    expect(m.receipts.map((x) => [x.status, x.rawStatus])).toEqual([
      ['UNKNOWN', 'confirm_persist_failed'],
    ]);
    expect(reconcileJob(m).payload).toMatchObject({
      reason: 'confirm_persist_failed',
    });
    await expect(runJob(m)).resolves.toEqual({ note: 'reconciled_confirmed' });
    expect(m.appointments[0].status).toBe('CONFIRMED');
    expect(m.receipts.filter((x) => x.status === 'CONFIRMED')).toHaveLength(1);
  });

  it('when not even the compensation job can be stored the booking is cancelled at the provider at once', async () => {
    const adapter = new SandboxSchedulingAdapter();
    const m = make(adapter);
    m.db.appointmentProviderReceipt.create.mockImplementation(async () => {
      throw new Error('database unavailable');
    });
    await expect(m.book()).rejects.toThrow('database unavailable');
    expect(await adapter.findByIdempotencyKey(ctx)).toBeNull();
    expect(m.appointments[0].status).toBe('REQUESTED');
  });

  it('an adapter that cannot look up by idempotency key is dead-lettered for staff, and cannot be registered at all', async () => {
    const m = make(stub(() => new Promise<SchedulingOutcome>(() => undefined)));
    await m.book();
    await expect(runJob(m)).rejects.toBeInstanceOf(PermanentOutboxError);
    const registry = new SchedulingProviderRegistry(
      {} as never,
      { isOpen: () => false } as never,
    );
    expect(() => registry.register('STUB', stub({} as never))).toThrow(
      'scheduler_adapter_missing_idempotent_lookup',
    );
    expect(() =>
      registry.register('MOCK', new SandboxSchedulingAdapter()),
    ).not.toThrow();
  });

  it('sandbox adapter honours the idempotency key: same key ⇒ same booking; lookup and cancel are scoped to tenant + location', async () => {
    const adapter = new SandboxSchedulingAdapter();
    const req = { department: 'TEST_DRIVE' as const, startUtc: slotStart };
    const a = await adapter.create(ctx, req);
    const b = await adapter.create(ctx, req);
    expect(a).toEqual(b);
    expect(await adapter.findByIdempotencyKey(ctx)).toMatchObject({
      externalId: (a as { externalId: string }).externalId,
    });
    expect(
      await adapter.findByIdempotencyKey({ ...ctx, tenantId: 't2' }),
    ).toBeNull();
    expect(
      await adapter.cancelByIdempotencyKey({ ...ctx, locationId: 'l2' }),
    ).toEqual({ cancelled: false });
    expect(await adapter.cancelByIdempotencyKey(ctx)).toEqual({
      cancelled: true,
      externalId: (a as { externalId: string }).externalId,
    });
    expect(await adapter.cancelByIdempotencyKey(ctx)).toEqual({
      cancelled: false,
    });
  });
});
