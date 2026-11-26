import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import Redis from 'ioredis';
import { TurnLockService } from './turn-lock.service';

jest.mock('ioredis', () => jest.fn());

describe('TurnLockService (in-process; no REDIS_URL)', () => {
  const prev = process.env.REDIS_URL;
  beforeAll(() => delete process.env.REDIS_URL);
  afterAll(() => {
    if (prev !== undefined) process.env.REDIS_URL = prev;
  });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('runs turns of the same conversation one at a time, in arrival order', async () => {
    const lock = new TurnLockService();
    const log: string[] = [];
    let inside = 0;
    let maxInside = 0;
    const turn = (n: number) =>
      lock.run('t1:cv1.a', async () => {
        inside += 1;
        maxInside = Math.max(maxInside, inside);
        log.push(`start ${n}`);
        await sleep(10);
        log.push(`end ${n}`);
        inside -= 1;
        return n;
      });
    const out = await Promise.all([1, 2, 3, 4, 5].map(turn));
    expect(out).toEqual([1, 2, 3, 4, 5]);
    expect(maxInside).toBe(1);
    expect(log.slice(0, 4)).toEqual(['start 1', 'end 1', 'start 2', 'end 2']);
  });

  it('different conversations are not serialised against each other', async () => {
    const lock = new TurnLockService();
    let inside = 0;
    let maxInside = 0;
    await Promise.all(
      ['a', 'b', 'c'].map((k) =>
        lock.run(`t1:${k}`, async () => {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          await sleep(15);
          inside -= 1;
        }),
      ),
    );
    expect(maxInside).toBe(3);
  });

  it('a turn that waits too long is refused as busy and never runs', async () => {
    const lock = new TurnLockService();
    let ran = false;
    const slow = lock.run('t1:x', () => sleep(80));
    await expect(
      lock.run(
        't1:x',
        async () => {
          ran = true;
        },
        { waitMs: 20 },
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    await slow;
    expect(ran).toBe(false);
    // and the key is usable again afterwards
    await expect(lock.run('t1:x', async () => 'ok')).resolves.toBe('ok');
  });

  it('a failing turn releases the lock for the next one', async () => {
    const lock = new TurnLockService();
    await expect(
      lock.run('t1:y', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(lock.run('t1:y', async () => 'next')).resolves.toBe('next');
  });

  it('does not let a later turn overtake an active turn after a waiter times out', async () => {
    const lock = new TurnLockService();
    let finish!: () => void;
    const active = lock.run(
      't1:z',
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const work = jest.fn(async () => 'ok');
    try {
      await expect(
        lock.run('t1:z', work, { waitMs: 5 }),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        lock.run('t1:z', work, { waitMs: 5 }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(work).not.toHaveBeenCalled();
    } finally {
      finish();
      await active;
    }
    await expect(lock.run('t1:z', work)).resolves.toBe('ok');
  });

  it('passes a held handle whose fence is empty when Redis is not required', async () => {
    const lock = new TurnLockService();
    await lock.run('t1:local', async (held) => {
      expect(held.fence).toBe('');
      expect(held.signal.aborted).toBe(false);
      held.assertHeld();
      return 'ok';
    });
  });
});

describe('TurnLockService (distributed)', () => {
  const initialRedisUrl = process.env.REDIS_URL;
  const initialTier = process.env.DEPLOYMENT_TIER;

  afterEach(() => {
    if (initialRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = initialRedisUrl;
    if (initialTier === undefined) delete process.env.DEPLOYMENT_TIER;
    else process.env.DEPLOYMENT_TIER = initialTier;
    jest.clearAllMocks();
  });

  it('refuses hosted turns when Redis is missing', async () => {
    delete process.env.REDIS_URL;
    process.env.DEPLOYMENT_TIER = 'staging';
    const work = jest.fn();
    await expect(
      new TurnLockService().run('tenant:conversation', work),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(work).not.toHaveBeenCalled();
  });

  it('refuses turns during Redis outages and resumes after Redis recovers', async () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:6379';
    const events = new Map<string, () => void>();
    const set = jest
      .fn()
      .mockRejectedValueOnce(new Error('socket closed'))
      .mockResolvedValue('OK');
    (Redis as unknown as jest.Mock).mockImplementation(() => ({
      on: (event: string, callback: () => void) => events.set(event, callback),
      set,
      eval: jest.fn().mockResolvedValue(1),
      disconnect: jest.fn(),
    }));
    const lock = new TurnLockService();
    const work = jest.fn(async () => 'ok');
    const run = () => lock.run('tenant:conversation', work);

    await expect(run()).rejects.toBeInstanceOf(ServiceUnavailableException);
    events.get('ready')?.();
    await expect(run()).rejects.toBeInstanceOf(ServiceUnavailableException);
    events.get('close')?.();
    await expect(run()).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(work).not.toHaveBeenCalled();
    events.get('ready')?.();
    await expect(run()).resolves.toBe('ok');
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('fails the turn and does not RELEASE when a renew reports the lease is gone', async () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:6379';
    const events = new Map<string, () => void>();
    const evalFn = jest
      .fn()
      // first renew while the turn is in flight → token mismatch
      .mockResolvedValueOnce(0)
      .mockResolvedValue(1);
    (Redis as unknown as jest.Mock).mockImplementation(() => ({
      on: (event: string, callback: () => void) => events.set(event, callback),
      set: jest.fn().mockResolvedValue('OK'),
      eval: evalFn,
      disconnect: jest.fn(),
    }));
    const lock = new TurnLockService();
    events.get('ready')?.();

    let heldRef: { assertHeld: () => void; signal: AbortSignal } | null = null;
    let resolveBody!: (v: string) => void;
    const turn = lock.run(
      'tenant:conversation',
      (held) => {
        heldRef = held;
        expect(held.fence.length).toBeGreaterThan(0);
        return new Promise<string>((resolve) => {
          resolveBody = resolve;
        });
      },
      { ttlMs: 90 },
    );

    // Wait for at least one renew interval (ttl/3 ≈ 30ms).
    await new Promise((r) => setTimeout(r, 50));
    expect(evalFn).toHaveBeenCalled();
    expect(heldRef!.signal.aborted).toBe(true);
    expect(() => heldRef!.assertHeld()).toThrow(ServiceUnavailableException);
    // Completing the body after lease loss must still fail closed (no successful return).
    resolveBody('should-not-return');
    await expect(turn).rejects.toBeInstanceOf(ServiceUnavailableException);
    // RELEASE must never run after loss — would delete a peer's key.
    const releaseCalls = evalFn.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('del'),
    );
    expect(releaseCalls).toHaveLength(0);
  });

  it('returns success only when the lease is still held at the end of the turn', async () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:6379';
    const events = new Map<string, () => void>();
    const evalFn = jest.fn().mockResolvedValue(1);
    (Redis as unknown as jest.Mock).mockImplementation(() => ({
      on: (event: string, callback: () => void) => events.set(event, callback),
      set: jest.fn().mockResolvedValue('OK'),
      eval: evalFn,
      disconnect: jest.fn(),
    }));
    const lock = new TurnLockService();
    events.get('ready')?.();
    await expect(
      lock.run('tenant:conversation', async (held) => {
        held.assertHeld();
        return 'ok';
      }),
    ).resolves.toBe('ok');
    // RELEASE (del) after a successful hold.
    expect(
      evalFn.mock.calls.some(
        (c) => typeof c[0] === 'string' && c[0].includes('del'),
      ),
    ).toBe(true);
  });
});
