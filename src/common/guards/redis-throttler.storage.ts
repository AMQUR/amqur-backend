import { Logger, OnApplicationShutdown } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';

type ThrottlerStorageRecord = Awaited<
  ReturnType<ThrottlerStorage['increment']>
>;

/** Minimal slice of ioredis used here (so tests can pass a fake). */
export type RedisEvalClient = {
  eval: (
    script: string,
    keys: number,
    ...args: Array<string | number>
  ) => Promise<unknown>;
  on?: (ev: string, cb: (...a: unknown[]) => void) => void;
  disconnect?: () => void;
};

/**
 * Fixed window per key, shared by every API replica. KEYS[1] counts hits for the window,
 * KEYS[2] marks a block. Returns {hits, windowMsLeft, blocked, blockMsLeft}.
 */
export const THROTTLE_SCRIPT = `
local blk = redis.call('pttl', KEYS[2])
if blk > 0 then
  local h = tonumber(redis.call('get', KEYS[1]) or '0')
  local w = redis.call('pttl', KEYS[1])
  if w < 0 then w = 0 end
  return {h, w, 1, blk}
end
local h = redis.call('incr', KEYS[1])
local w = redis.call('pttl', KEYS[1])
if w < 0 then
  redis.call('pexpire', KEYS[1], ARGV[1])
  w = tonumber(ARGV[1])
end
if h > tonumber(ARGV[2]) then
  redis.call('set', KEYS[2], '1', 'PX', ARGV[3])
  return {h, w, 1, tonumber(ARGV[3])}
end
return {h, w, 0, 0}
`;

const seconds = (ms: number) => Math.max(0, Math.ceil(ms / 1000));

/**
 * Rate-limit counters in Redis, so a limit means the same thing with one API replica or many
 * (the in-memory default counts per process: two replicas let twice the attempts through).
 * When Redis is not configured, or a call fails or is slow, the request is counted by the
 * in-process store instead: degraded to per-replica limits, never unlimited, never blocked.
 */
export class RedisThrottlerStorage
  implements ThrottlerStorage, OnApplicationShutdown
{
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private readonly local = new ThrottlerStorageService();
  private warned = false;

  constructor(
    private readonly redis: RedisEvalClient | null,
    private readonly prefix = 'thr:',
  ) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    if (!this.redis)
      return this.local.increment(
        key,
        ttl,
        limit,
        blockDuration,
        throttlerName,
      );
    const base = `${this.prefix}${throttlerName}:${key}`;
    try {
      const r = (await this.redis.eval(
        THROTTLE_SCRIPT,
        2,
        `${base}:h`,
        `${base}:b`,
        ttl,
        limit,
        blockDuration,
      )) as unknown[];
      const [hits, windowMs, blocked, blockMs] = (r ?? []).map(Number);
      if (![hits, windowMs, blocked, blockMs].every(Number.isFinite))
        throw new Error('bad_throttle_reply');
      this.warned = false;
      return {
        totalHits: hits,
        timeToExpire: seconds(windowMs),
        isBlocked: blocked === 1,
        timeToBlockExpire: seconds(blockMs),
      };
    } catch {
      if (!this.warned) {
        this.warned = true;
        this.logger.warn(
          'rate-limit store unavailable; counting per replica until it recovers',
        );
      }
      return this.local.increment(
        key,
        ttl,
        limit,
        blockDuration,
        throttlerName,
      );
    }
  }

  onApplicationShutdown() {
    this.local.onApplicationShutdown();
    this.redis?.disconnect?.();
  }
}

/** Shared storage when REDIS_URL is set; in-process storage otherwise. */
export function createThrottlerStorage(
  url: string | undefined = process.env.REDIS_URL,
  env: NodeJS.ProcessEnv = process.env,
): RedisThrottlerStorage {
  const u = url?.trim();
  // Test runs start many app instances against one Redis; each keeps its own counts unless a
  // test opts in to the shared store explicitly.
  const isolated =
    env.NODE_ENV === 'test' && env.RATE_LIMIT_SHARED_STORE !== 'true';
  if (!u || isolated) return new RedisThrottlerStorage(null);
  try {
    const Redis = require('ioredis') as new (
      u: string,
      o?: Record<string, unknown>,
    ) => RedisEvalClient;
    const client = new Redis(u, {
      // A slow or absent Redis must never hold a request: fail fast to the local count.
      enableOfflineQueue: false,
      commandTimeout: 500,
      maxRetriesPerRequest: 1,
      lazyConnect: false,
    });
    client.on?.('error', () => undefined);
    return new RedisThrottlerStorage(client);
  } catch {
    return new RedisThrottlerStorage(null);
  }
}
