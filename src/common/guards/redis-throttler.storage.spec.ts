import {
  createThrottlerStorage,
  RedisEvalClient,
  RedisThrottlerStorage,
  THROTTLE_SCRIPT,
} from './redis-throttler.storage';

/** A tiny in-memory model of the Lua script, shared between "replicas". */
function fakeRedis(now: () => number) {
  const kv = new Map<string, { v: number; exp: number }>();
  const live = (k: string) => {
    const e = kv.get(k);
    if (e && e.exp <= now()) kv.delete(k);
    return kv.get(k);
  };
  const client: RedisEvalClient & { calls: number } = {
    calls: 0,
    eval: (script, _n, hk, bk, ttl, limit, block) => {
      client.calls++;
      expect(script).toBe(THROTTLE_SCRIPT);
      const b = live(String(bk));
      if (b) {
        const h = live(String(hk));
        return Promise.resolve([
          h?.v ?? 0,
          h ? h.exp - now() : 0,
          1,
          b.exp - now(),
        ]);
      }
      let h = live(String(hk));
      if (!h) {
        h = { v: 0, exp: now() + Number(ttl) };
        kv.set(String(hk), h);
      }
      h.v++;
      if (h.v > Number(limit)) {
        kv.set(String(bk), { v: 1, exp: now() + Number(block) });
        return Promise.resolve([h.v, h.exp - now(), 1, Number(block)]);
      }
      return Promise.resolve([h.v, h.exp - now(), 0, 0]);
    },
  };
  return client;
}

describe('shared rate-limit storage', () => {
  it('two replicas share one count: the limit holds across them', async () => {
    let t = 1_000_000;
    const redis = fakeRedis(() => t);
    const a = new RedisThrottlerStorage(redis);
    const b = new RedisThrottlerStorage(redis);
    const results: Array<{ isBlocked: boolean }> = [];
    for (let i = 0; i < 25; i++)
      results.push(
        await (i % 2 ? a : b).increment('ip:1', 60_000, 20, 60_000, 'auth'),
      );
    expect(results.filter((r) => !r.isBlocked)).toHaveLength(20);
    expect(results[20]).toMatchObject({
      isBlocked: true,
      timeToBlockExpire: 60,
    });
    // Window and block expire: allowed again.
    t += 61_000;
    expect(
      (await a.increment('ip:1', 60_000, 20, 60_000, 'auth')).isBlocked,
    ).toBe(false);
  });

  it('keys are separated per throttler and per tracker', async () => {
    const redis = fakeRedis(() => 0);
    const s = new RedisThrottlerStorage(redis);
    for (let i = 0; i < 3; i++)
      await s.increment('ip:1', 60_000, 2, 60_000, 'auth');
    expect(
      (await s.increment('ip:1', 60_000, 2, 60_000, 'default')).isBlocked,
    ).toBe(false);
    expect(
      (await s.increment('ip:2', 60_000, 2, 60_000, 'auth')).isBlocked,
    ).toBe(false);
  });

  it('falls back to a per-replica count when Redis fails, never unlimited', async () => {
    const broken: RedisEvalClient = {
      eval: () => Promise.reject(new Error('ECONNREFUSED')),
    };
    const s = new RedisThrottlerStorage(broken);
    const out: Array<{ isBlocked: boolean }> = [];
    for (let i = 0; i < 4; i++)
      out.push(await s.increment('ip:1', 60_000, 3, 60_000, 'auth'));
    expect(out.map((r) => r.isBlocked)).toEqual([false, false, false, true]);
    s.onApplicationShutdown();
  });

  it('a malformed reply is treated as a failure', async () => {
    const odd: RedisEvalClient = { eval: () => Promise.resolve(['x']) };
    const s = new RedisThrottlerStorage(odd);
    expect(
      (await s.increment('k', 60_000, 5, 60_000, 'default')).totalHits,
    ).toBe(1);
    s.onApplicationShutdown();
  });

  it('without Redis it behaves like the in-memory store', async () => {
    const s = new RedisThrottlerStorage(null);
    const r = await s.increment('k', 60_000, 5, 60_000, 'default');
    expect(r).toMatchObject({ totalHits: 1, isBlocked: false });
    s.onApplicationShutdown();
  });

  it('test runs keep per-instance counts unless they opt in', () => {
    const local = createThrottlerStorage('redis://127.0.0.1:1', {
      NODE_ENV: 'test',
    });
    expect((local as unknown as { redis: unknown }).redis).toBeNull();
    local.onApplicationShutdown();
  });
});
