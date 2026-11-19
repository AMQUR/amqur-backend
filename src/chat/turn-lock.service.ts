import {
  ConflictException,
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { randomBytes } from 'crypto';

/**
 * One turn at a time per conversation.
 *
 * A turn reads the conversation state, may create records (lead, consent, delivery, booking)
 * and only then saves the state. Two turns of the SAME conversation running together both see
 * the old state, so a lead form submitted twice at once created two leads, two consent sets and
 * two CRM deliveries, and the loser then failed with a state conflict (soak concurrency C2/C3).
 *
 * Turns of one conversation are therefore serialised:
 *  - always within this process (a promise chain per key);
 *  - across processes with a Redis lock (SET NX PX, renewed while held, released only by its
 *    holder). Without Redis — not configured, or down — only the in-process chain applies and
 *    the state store's optimistic check remains the last line of defence.
 * A turn that cannot get the lock within `waitMs` is refused with 409 `conversation_busy`
 * (the widget shows its retry), never run in parallel.
 */
type RedisLike = {
  set: (...args: Array<string | number>) => Promise<string | null>;
  eval: (
    script: string,
    keys: number,
    ...args: Array<string | number>
  ) => Promise<unknown>;
  on: (ev: string, cb: (...a: unknown[]) => void) => void;
  disconnect: () => void;
};

const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
const RENEW = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;

export const TURN_LOCK_TTL_MS = 30_000;
export const TURN_LOCK_WAIT_MS = 20_000;

@Injectable()
export class TurnLockService implements OnModuleDestroy {
  private readonly logger = new Logger(TurnLockService.name);
  private readonly chains = new Map<string, Promise<void>>();
  private redis: RedisLike | null = null;
  private redisReady = false;

  constructor() {
    const url = process.env.REDIS_URL?.trim();
    if (!url) return;
    try {
      const Redis = require('ioredis') as new (
        u: string,
        o?: Record<string, unknown>,
      ) => RedisLike;
      const client = new Redis(url, {
        connectTimeout: 1_500,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
      });
      client.on('error', () => {
        this.redisReady = false;
      });
      client.on('ready', () => {
        this.redisReady = true;
      });
      this.redis = client;
    } catch {
      this.logger.warn('ioredis not available — turn lock is in-process only');
    }
  }

  onModuleDestroy() {
    this.redis?.disconnect();
  }

  /** Run `fn` holding the lock for `key` (tenant + conversation). */
  async run<T>(
    key: string,
    fn: () => Promise<T>,
    opts: { waitMs?: number; ttlMs?: number } = {},
  ): Promise<T> {
    const waitMs = opts.waitMs ?? TURN_LOCK_WAIT_MS;
    const ttlMs = opts.ttlMs ?? TURN_LOCK_TTL_MS;
    const deadline = Date.now() + waitMs;

    // 1. In-process: wait for the previous turn of this key in this process.
    const prev = this.chains.get(key) ?? Promise.resolve();
    let releaseLocal!: () => void;
    const mine = new Promise<void>((r) => (releaseLocal = r));
    const tail = prev.then(() => mine);
    this.chains.set(key, tail);
    try {
      const waited = await Promise.race([
        prev.then(() => true),
        sleep(Math.max(0, deadline - Date.now())).then(() => false),
      ]);
      if (!waited) throw busy();

      // 2. Cross-process.
      const token = await this.acquireRemote(key, ttlMs, deadline);
      const renew = token
        ? setInterval(
            () => {
              void this.redis
                ?.eval(RENEW, 1, redisKey(key), token, ttlMs)
                .catch(() => undefined);
            },
            Math.floor(ttlMs / 3),
          )
        : null;
      renew?.unref();
      try {
        return await fn();
      } finally {
        if (renew) clearInterval(renew);
        if (token)
          await this.redis
            ?.eval(RELEASE, 1, redisKey(key), token)
            .catch(() => undefined);
      }
    } finally {
      releaseLocal();
      if (this.chains.get(key) === tail) this.chains.delete(key);
    }
  }

  /** Lock token, or null when Redis is not usable (in-process serialisation only). */
  private async acquireRemote(
    key: string,
    ttlMs: number,
    deadline: number,
  ): Promise<string | null> {
    if (!this.redis || !this.redisReady) return null;
    const token = randomBytes(12).toString('base64url');
    let delay = 15;
    for (;;) {
      let ok: string | null;
      try {
        ok = await this.redis.set(redisKey(key), token, 'PX', ttlMs, 'NX');
      } catch {
        return null; // Redis failed mid-acquire: degrade, never block the customer on it
      }
      if (ok === 'OK') return token;
      if (Date.now() + delay > deadline) throw busy();
      await sleep(delay);
      delay = Math.min(delay * 2, 250);
    }
  }
}

const redisKey = (key: string) => `amqur:turn-lock:${key}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const busy = () =>
  new ConflictException({
    message: 'conversation_busy',
    detail: 'Another message in this conversation is still being answered.',
  });
