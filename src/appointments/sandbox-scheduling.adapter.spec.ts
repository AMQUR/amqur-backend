import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { SandboxSchedulerRegistrar } from './sandbox-scheduler.registrar';
import {
  assertSandboxSchedulerAllowed,
  SANDBOX_SCHEDULER_PROVIDER,
  SandboxSchedulingAdapter,
  sandboxReference,
  sandboxSlots,
  sandboxTakenSlotStart,
} from './sandbox-scheduling.adapter';
import type { SchedulingContext } from './scheduling-provider';
import { SchedulingProviderRegistry } from './scheduling-provider.registry';

const now = new Date('2026-10-13T15:00:00.000Z');
const ctx = (over: Partial<SchedulingContext> = {}): SchedulingContext => ({
  tenantId: 't1',
  locationId: 'l1',
  connectionId: 'c1',
  mode: 'sandbox',
  timeoutMs: 1000,
  idempotencyKey: 'key-1',
  correlationId: 'appt-1',
  now,
  ...over,
});
const withEnv = async (env: string, fn: () => unknown) => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = env;
  try {
    return await fn();
  } finally {
    process.env.NODE_ENV = prev;
  }
};

describe('SandboxSchedulingAdapter', () => {
  it('offers a deterministic grid for the next four days', async () => {
    const a = new SandboxSchedulingAdapter();
    const q = {
      department: 'TEST_DRIVE' as const,
      fromUtc: now.toISOString(),
      toUtc: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
    };
    const first = await a.getAvailability(ctx(), q);
    expect(first).toEqual(await a.getAvailability(ctx(), q));
    expect(first).toEqual(sandboxSlots(now));
    expect(first).toHaveLength(16);
    expect(first[0].startUtc).toBe('2026-10-14T15:00:00.000Z');
    expect(first[15].startUtc).toBe('2026-10-17T21:00:00.000Z');
    expect(sandboxTakenSlotStart(now)).toBe(first[1].startUtc);
    expect(a.sandbox).toBe(true);
    expect(a.providerId).toBe(SANDBOX_SCHEDULER_PROVIDER);
  });

  it('confirms an offered slot with an SBX- reference; a replay is the same booking', async () => {
    const a = new SandboxSchedulingAdapter();
    const startUtc = sandboxSlots(now)[0].startUtc;
    const r = await a.create(ctx(), { department: 'TEST_DRIVE', startUtc });
    expect(r).toMatchObject({
      kind: 'confirmed',
      providerStatus: 'CONFIRMED',
      rawStatus: 'SANDBOX_CONFIRMED',
      scheduledAtUtc: startUtc,
    });
    if (r.kind !== 'confirmed') throw new Error('unreachable');
    expect(r.externalId).toMatch(/^SBX-1014-15-[0-9A-F]{6}$/);
    expect(r.externalId).toBe(sandboxReference('key-1', startUtc));
    expect(
      await a.create(ctx(), { department: 'TEST_DRIVE', startUtc }),
    ).toEqual(r);
  });

  it('always rejects the designated slot, and anything off the grid', async () => {
    const a = new SandboxSchedulingAdapter();
    const taken = await a.create(ctx(), {
      department: 'SALES',
      startUtc: sandboxTakenSlotStart(now),
    });
    expect(taken).toMatchObject({ kind: 'unavailable', reason: 'slot_taken' });
    for (const startUtc of [
      '2026-10-14T16:30:00.000Z',
      '2026-12-01T15:00:00.000Z',
      'nope',
    ])
      expect(
        await a.create(ctx(), { department: 'SALES', startUtc }),
      ).toMatchObject({
        kind: 'unavailable',
        reason: 'not_a_sandbox_slot',
      });
  });

  it('two bookings racing for one slot: exactly one is confirmed', async () => {
    const a = new SandboxSchedulingAdapter(
      () => new Promise((r) => setTimeout(() => r(false), 5)),
    );
    const startUtc = sandboxSlots(now)[2].startUtc;
    const res = await Promise.all([
      a.create(ctx({ idempotencyKey: 'A' }), { department: 'SALES', startUtc }),
      a.create(ctx({ idempotencyKey: 'B' }), { department: 'SALES', startUtc }),
    ]);
    expect(res.map((r) => r.kind).sort()).toEqual(['confirmed', 'unavailable']);
    // …and the held slot is no longer offered, while another rooftop is unaffected
    const q = {
      department: 'SALES' as const,
      fromUtc: now.toISOString(),
      toUtc: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
    };
    expect(
      (await a.getAvailability(ctx(), q)).map((s) => s.startUtc),
    ).not.toContain(startUtc);
    expect(
      (await a.getAvailability(ctx({ locationId: 'l2' }), q)).map(
        (s) => s.startUtc,
      ),
    ).toContain(startUtc);
    expect(
      await a.create(ctx({ locationId: 'l2', idempotencyKey: 'C' }), {
        department: 'SALES',
        startUtc,
      }),
    ).toMatchObject({ kind: 'confirmed' });
  });

  it('respects a durable booking for the slot, and frees it on cancel', async () => {
    const booked = jest.fn().mockResolvedValue(true);
    const a = new SandboxSchedulingAdapter(booked);
    const startUtc = sandboxSlots(now)[3].startUtc;
    expect(
      await a.create(ctx(), { department: 'SALES', startUtc }),
    ).toMatchObject({
      kind: 'unavailable',
      reason: 'slot_taken',
    });
    booked.mockResolvedValue(false);
    const ok = await a.create(ctx(), { department: 'SALES', startUtc });
    if (ok.kind !== 'confirmed') throw new Error('expected confirmed');
    await a.cancel(ctx(), ok.externalId);
    expect(
      await a.create(ctx({ idempotencyKey: 'other' }), {
        department: 'SALES',
        startUtc,
      }),
    ).toMatchObject({ kind: 'confirmed' });
  });
});

describe('sandbox scheduler can never exist in production', () => {
  const registry = () =>
    new SchedulingProviderRegistry(
      {
        integrationConnection: { findMany: jest.fn().mockResolvedValue([]) },
      } as never,
      { isOpen: () => false } as never,
    );

  it('the adapter cannot be constructed or used', async () => {
    await withEnv('production', () => {
      expect(() => new SandboxSchedulingAdapter()).toThrow(
        'sandbox_scheduler_forbidden_in_production',
      );
      expect(() => assertSandboxSchedulerAllowed()).toThrow();
    });
    const a = new SandboxSchedulingAdapter();
    await withEnv('production', async () => {
      await expect(
        a.create(ctx(), {
          department: 'SALES',
          startUtc: sandboxSlots(now)[0].startUtc,
        }),
      ).rejects.toThrow('sandbox_scheduler_forbidden_in_production');
      expect(() =>
        a.getAvailability(ctx(), {
          department: 'SALES',
          fromUtc: '',
          toUtc: '',
        }),
      ).toThrow('sandbox_scheduler_forbidden_in_production');
    });
  });

  it('the registry refuses to register a sandbox adapter', async () => {
    const a = new SandboxSchedulingAdapter();
    const r = registry();
    await withEnv('production', () => {
      expect(() => r.register(SANDBOX_SCHEDULER_PROVIDER, a)).toThrow(
        'sandbox_scheduler_forbidden_in_production',
      );
    });
    expect(r.registeredProviders()).toEqual([]);
  });

  it('the registrar registers nothing at boot', async () => {
    const r = registry();
    const registrar = new SandboxSchedulerRegistrar(
      r,
      {} as never,
      {} as never,
    );
    await withEnv('production', () => {
      expect(registrar.registerIfAllowed()).toBe(false);
      registrar.onModuleInit();
    });
    expect(r.registeredProviders()).toEqual([]);
    // outside production it does register (still gated per tenant by flag + connection)
    expect(registrar.registerIfAllowed()).toBe(true);
    expect(r.registeredProviders()).toEqual([SANDBOX_SCHEDULER_PROVIDER]);
  });

  it('the sandboxScheduler flag is forced off', async () => {
    const flags = new FeatureFlagsService({
      tenant: {
        findUnique: jest.fn().mockResolvedValue({
          featureFlags: { sandboxScheduler: true, salesDeskCards: true },
        }),
      },
      location: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ featureFlags: { sandboxScheduler: true } }),
      },
      integrationConnection: { findFirst: jest.fn().mockResolvedValue(null) },
    } as never);
    expect((await flags.resolve('t1', 'l1')).sandboxScheduler).toBe(true);
    await withEnv('production', async () => {
      const f = await flags.resolve('t1', 'l1');
      expect(f.sandboxScheduler).toBe(false);
      expect(f.salesDeskCards).toBe(true); // the cards flag is a normal flag
      expect((await flags.explain('t1', 'l1')).sandboxScheduler).toEqual({
        enabled: false,
        reason: 'sandbox_scheduler_forbidden_in_production',
      });
    });
  });
});

describe('SchedulingProviderRegistry.resolve — gates', () => {
  const conn = (over = {}) => ({
    id: 'c1',
    provider: 'MOCK',
    locationId: 'l1',
    config: { mode: 'sandbox' },
    ...over,
  });
  const make = (rows: object[], open = false) =>
    new SchedulingProviderRegistry(
      {
        integrationConnection: { findMany: jest.fn().mockResolvedValue(rows) },
      } as never,
      { isOpen: () => open } as never,
    );

  it('needs an enabled connection, a registered adapter and an open gate', async () => {
    const adapter = new SandboxSchedulingAdapter();
    const none = make([]);
    none.register('MOCK', adapter);
    expect(await none.resolve('t1', 'l1')).toBeNull();

    const unregistered = make([conn()]);
    expect(await unregistered.resolve('t1', 'l1')).toBeNull();

    const gate = jest.fn().mockResolvedValue(false);
    const gated = make([conn()]);
    gated.register('MOCK', adapter, gate);
    expect(await gated.resolve('t1', 'l1')).toBeNull();
    expect(gate).toHaveBeenCalledWith('t1', 'l1');
    gate.mockResolvedValue(true);
    expect(await gated.resolve('t1', 'l1')).toMatchObject({
      provider: 'MOCK',
      connectionId: 'c1',
      sandbox: true,
      displayName: 'Sandbox scheduler',
      mode: 'sandbox',
    });
    gate.mockRejectedValue(new Error('flags down'));
    expect(await gated.resolve('t1', 'l1')).toBeNull(); // fail closed

    const breakerOpen = make([conn()], true);
    breakerOpen.register('MOCK', adapter);
    expect(await breakerOpen.resolve('t1', 'l1')).toBeNull();
  });

  it('honours a per-connection department allow-list', async () => {
    const r = make([conn({ config: { departments: ['SERVICE'] } })]);
    r.register('MOCK', new SandboxSchedulingAdapter());
    expect(await r.resolve('t1', 'l1', 'TEST_DRIVE')).toBeNull();
    expect(await r.resolve('t1', 'l1', 'SERVICE')).not.toBeNull();
    expect(await r.resolve('t1', 'l1')).not.toBeNull(); // legacy callers
  });

  it('a registered sandbox adapter is never resolved once in production', async () => {
    const r = make([conn()]);
    r.register('MOCK', new SandboxSchedulingAdapter());
    await withEnv('production', async () => {
      expect(await r.resolve('t1', 'l1')).toBeNull();
    });
  });
});
