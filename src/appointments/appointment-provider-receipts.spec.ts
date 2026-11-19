import { Prisma } from '@prisma/client';
import { AppointmentService } from './appointment.service';
import {
  SandboxSchedulingAdapter,
  sandboxSlots,
  sandboxTakenSlotStart,
} from './sandbox-scheduling.adapter';
import type { ResolvedScheduler } from './scheduling-provider.registry';
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
  };
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
    outboxEvent: { create: jest.fn().mockResolvedValue({}) },
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
    };
    try {
      return await fn(db);
    } catch (e) {
      appointments.splice(0, appointments.length, ...snapshot.a);
      receipts.length = snapshot.r;
      throw e;
    }
  });
  return { db, appointments, receipts };
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

  it('a provider failure/timeout keeps the request REQUESTED with a FAILED receipt', async () => {
    const m = make(stub(() => new Promise<SchedulingOutcome>(() => undefined)));
    const r = await m.book();
    expect(r).toMatchObject({
      status: 'saved',
      outcome: 'requested',
      providerFailure: 'provider_timeout',
    });
    expect(r).not.toHaveProperty('provider');
    expect(m.appointments[0].status).toBe('REQUESTED');
    expect(m.receipts.map((x) => [x.status, x.rawStatus, x.sandbox])).toEqual([
      ['FAILED', 'provider_timeout', true],
    ]);
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
