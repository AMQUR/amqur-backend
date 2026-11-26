import { randomBytes } from 'crypto';

type RedisLike = {
  set: (...args: Array<string | number>) => Promise<string | null>;
  eval: (
    script: string,
    keys: number,
    ...args: Array<string | number>
  ) => Promise<unknown>;
  quit?: () => Promise<void>;
  disconnect?: () => void;
};

const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

export const SFTP_INGEST_LOCK_KEY = 'amqur:inventory:vauto-sftp-ingest';
/** Cover a full ten-source pass with headroom; TTL auto-expires on crash. */
export const SFTP_INGEST_LOCK_TTL_MS = 15 * 60 * 1000;

function remoteLockRequired(): boolean {
  const tier = (process.env.DEPLOYMENT_TIER ?? '').toLowerCase();
  return (
    Boolean(process.env.REDIS_URL?.trim()) ||
    tier === 'staging' ||
    tier === 'production'
  );
}

/**
 * Cross-process mutex for Dial Difference SFTP ingest.
 * Returns a release function when acquired, or null when another worker holds it
 * (or when a hosted tier lacks Redis — fail closed).
 * Local/dev without REDIS_URL returns a no-op release (in-process guard only).
 */
export async function tryAcquireSftpIngestLock(
  redisFactory: () => RedisLike | null = defaultRedis,
): Promise<(() => Promise<void>) | null> {
  const redis = redisFactory();
  if (!redis) {
    if (remoteLockRequired()) return null;
    return async () => undefined;
  }
  const token = randomBytes(16).toString('hex');
  const ok = await redis.set(
    SFTP_INGEST_LOCK_KEY,
    token,
    'PX',
    SFTP_INGEST_LOCK_TTL_MS,
    'NX',
  );
  if (ok !== 'OK') {
    try {
      redis.disconnect?.();
    } catch {
      /* ignore */
    }
    return null;
  }
  return async () => {
    try {
      await redis.eval(RELEASE, 1, SFTP_INGEST_LOCK_KEY, token);
    } finally {
      try {
        redis.disconnect?.();
      } catch {
        /* ignore */
      }
    }
  };
}

function defaultRedis(): RedisLike | null {
  const url = process.env.REDIS_URL?.trim();
  if (!url) return null;
  try {
    const Redis = require('ioredis') as new (
      u: string,
      o?: Record<string, unknown>,
    ) => RedisLike;
    return new Redis(url, {
      connectTimeout: 1_500,
      commandTimeout: 2_000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: false,
    });
  } catch {
    return null;
  }
}
