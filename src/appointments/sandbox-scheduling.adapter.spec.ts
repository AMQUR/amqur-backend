import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { SandboxSchedulerRegistrar } from './sandbox-scheduler.registrar';
import {
  assertSandboxSchedulerAllowed,
  sandboxSchedulerEnabled,
  SANDBOX_SCHEDULER_PROVIDER,
  SandboxSchedulingAdapter,
  sandboxReference,
  sandboxSlots,
  sandboxTakenSlotStart,
} from './sandbox-scheduling.adapter';
import type { SchedulingContext } from './scheduling-provider';
import { SchedulingProviderRegistry } from './scheduling-provider.registry';
import { envValidationSchema } from '../config/env.validation';

// The sandbox scheduler needs an explicit opt-in (R13); these specs exercise it.
process.env.SANDBOX_SCHEDULER_ENABLED = 'true';

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

describe('R13 — the sandbox scheduler needs an explicit SANDBOX_SCHEDULER_ENABLED=true', () => {
  const withSwitch = async (value: string | undefined, fn: () => unknown) => {
    const prev = process.env.SANDBOX_SCHEDULER_ENABLED;
    if (value === undefined) delete process.env.SANDBOX_SCHEDULER_ENABLED;
    else process.env.SANDBOX_SCHEDULER_ENABLED = value;
    try {
      return await fn();
    } finally {
      process.env.SANDBOX_SCHEDULER_ENABLED = prev;
    }
  };
  const conn = {
    id: 'c1',
    provider: 'MOCK',
    locationId: 'l1',
    config: { mode: 'sandbox' },
  };
  const registryWith = (rows: object[]) =>
    new SchedulingProviderRegistry(
      {
        integrationConnection: { findMany: jest.fn().mockResolvedValue(rows) },
      } as never,
      { isOpen: () => false } as never,
    );

  it('sandboxSchedulerEnabled: needs the switch AND a non-production NODE_ENV (an unset NODE_ENV is not enough)', () => {
    const on = (env: Record<string, string | undefined>) =>
      sandboxSchedulerEnabled(env);
    expect(on({ NODE_ENV: 'test', SANDBOX_SCHEDULER_ENABLED: 'true' })).toBe(
      true,
    );
    expect(on({ SANDBOX_SCHEDULER_ENABLED: 'true' })).toBe(true); // dev box, opted in
    expect(on({})).toBe(false); // NODE_ENV lost on a real host: still no demo scheduler
    expect(on({ NODE_ENV: 'development' })).toBe(false);
    expect(on({ NODE_ENV: 'test', SANDBOX_SCHEDULER_ENABLED: 'false' })).toBe(
      false,
    );
    expect(on({ NODE_ENV: 'test', SANDBOX_SCHEDULER_ENABLED: 'TRUE' })).toBe(
      false,
    );
    expect(
      on({ NODE_ENV: 'production', SANDBOX_SCHEDULER_ENABLED: 'true' }),
    ).toBe(false);
  });

  for (const value of [undefined, 'false', '1']) {
    it(`switch=${String(value)}: not constructible, not registrable, not registered at boot, never resolved`, async () => {
      const existing = new SandboxSchedulingAdapter(); // built while opted in
      const armed = registryWith([conn]);
      armed.register('MOCK', existing);
      expect(await armed.resolve('t1', 'l1')).not.toBeNull();

      await withSwitch(value, async () => {
        expect(() => new SandboxSchedulingAdapter()).toThrow(
          'sandbox_scheduler_not_enabled',
        );
        expect(() => assertSandboxSchedulerAllowed()).toThrow(
          'sandbox_scheduler_not_enabled',
        );
        await expect(
          existing.create(ctx(), {
            department: 'SALES',
            startUtc: sandboxSlots(now)[0].startUtc,
          }),
        ).rejects.toThrow('sandbox_scheduler_not_enabled');
        const r = registryWith([conn]);
        expect(() => r.register('MOCK', existing)).toThrow(
          'sandbox_scheduler_not_enabled',
        );
        const registrar = new SandboxSchedulerRegistrar(
          r,
          {} as never,
          {} as never,
        );
        expect(registrar.registerIfAllowed()).toBe(false);
        expect(r.registeredProviders()).toEqual([]);
        // An adapter registered earlier is not resolved once the switch is off.
        expect(await armed.resolve('t1', 'l1')).toBeNull();
      });
    });
  }

  it('production stays a hard refusal even with the switch on', async () => {
    await withEnv('production', () => {
      expect(process.env.SANDBOX_SCHEDULER_ENABLED).toBe('true');
      expect(() => new SandboxSchedulingAdapter()).toThrow(
        'sandbox_scheduler_forbidden_in_production',
      );
      expect(sandboxSchedulerEnabled()).toBe(false);
    });
  });

  it('env validation: default off; `true` is rejected in production', () => {
    const base = {
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      JWT_SECRET: 'x'.repeat(40),
    };
    const v = (env: Record<string, string>) =>
      envValidationSchema.validate(
        { ...base, ...env },
        { allowUnknown: true, abortEarly: false },
      );
    expect(v({ NODE_ENV: 'test' }).value.SANDBOX_SCHEDULER_ENABLED).toBe(
      'false',
    );
    expect(
      v({ NODE_ENV: 'test', SANDBOX_SCHEDULER_ENABLED: 'true' }).value
        .SANDBOX_SCHEDULER_ENABLED,
    ).toBe('true');
    expect(
      String(
        v({ NODE_ENV: 'production', SANDBOX_SCHEDULER_ENABLED: 'true' }).error,
      ),
    ).toContain('SANDBOX_SCHEDULER_ENABLED');
    expect(
      String(
        v({ NODE_ENV: 'production', SANDBOX_SCHEDULER_ENABLED: 'false' })
          .error ?? '',
      ),
    ).not.toContain('SANDBOX_SCHEDULER_ENABLED');
  });
});
