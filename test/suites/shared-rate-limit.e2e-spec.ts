import { randomUUID } from 'crypto';
import { createThrottlerStorage } from '../../src/common/guards/redis-throttler.storage';

/**
 * Against the real test Redis: two storage instances with their own connections stand in for
 * two API replicas. One limit must hold across both.
 */
describe('shared rate limit on a real Redis', () => {
  const url = process.env.REDIS_URL;
  const env = { NODE_ENV: 'test', RATE_LIMIT_SHARED_STORE: 'true' };
  const a = createThrottlerStorage(url, env);
  const b = createThrottlerStorage(url, env);
  afterAll(() => {
    a.onApplicationShutdown();
    b.onApplicationShutdown();
  });

  it('20 per minute across two replicas: the 21st attempt is blocked on either one', async () => {
    expect(url).toBeTruthy();
    await new Promise((r) => setTimeout(r, 300)); // connect
    const key = `login-${randomUUID()}`;
    const out: boolean[] = [];
    for (let i = 0; i < 24; i++)
      out.push(
        (await (i % 2 ? a : b).increment(key, 60_000, 20, 60_000, 'auth'))
          .isBlocked,
      );
    expect(out.slice(0, 20).every((x) => !x)).toBe(true);
    expect(out.slice(20).every((x) => x)).toBe(true);
    const next = await a.increment(key, 60_000, 20, 60_000, 'auth');
    expect(next.isBlocked).toBe(true);
    expect(next.timeToBlockExpire).toBeGreaterThan(50);
  });

  it('the window expires and the count starts over', async () => {
    const key = `short-${randomUUID()}`;
    for (let i = 0; i < 3; i++) await a.increment(key, 1_000, 2, 1_000, 'auth');
    expect((await b.increment(key, 1_000, 2, 1_000, 'auth')).isBlocked).toBe(
      true,
    );
    await new Promise((r) => setTimeout(r, 1_200));
    const again = await b.increment(key, 1_000, 2, 1_000, 'auth');
    expect(again).toMatchObject({ isBlocked: false, totalHits: 1 });
  });
});
