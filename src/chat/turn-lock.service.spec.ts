import { ConflictException } from '@nestjs/common';
import { TurnLockService } from './turn-lock.service';

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
});
