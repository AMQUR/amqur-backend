import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

type CacheEntry = { value: string; expiresAt: number };

/**
 * Optional Redis-backed cache for public widget config.
 * When REDIS_URL is unset or Redis is down, falls back to in-process TTL map.
 * Redis outage must never corrupt durable data — cache is advisory only.
 */
@Injectable()
export class ConfigCacheService implements OnModuleDestroy {
  private readonly logger = new Logger(ConfigCacheService.name);
  private readonly memory = new Map<string, CacheEntry>();
  private redis: {
    get: (k: string) => Promise<string | null>;
    set: (k: string, v: string, mode: string, ttl: number) => Promise<unknown>;
    del: (...keys: string[]) => Promise<unknown>;
    incrby: (k: string, by: number) => Promise<number>;
    expire: (k: string, ttl: number) => Promise<unknown>;
    quit: () => Promise<unknown>;
    disconnect: () => void;
    status: string;
  } | null = null;
  private redisEnabled = false;

  constructor() {
    const url = process.env.REDIS_URL?.trim();
    if (!url) return;
    // Lazy dynamic require keeps Redis optional at install time for unit tests.
    try {
      const Redis = require('ioredis') as new (
        u: string,
        opts?: Record<string, unknown>,
      ) => {
        get: (k: string) => Promise<string | null>;
        set: (
          k: string,
          v: string,
          mode: string,
          ttl: number,
        ) => Promise<unknown>;
        del: (...keys: string[]) => Promise<unknown>;
        incrby: (k: string, by: number) => Promise<number>;
        expire: (k: string, ttl: number) => Promise<unknown>;
        quit: () => Promise<unknown>;
        disconnect: () => void;
        status: string;
        on: (ev: string, cb: (...a: unknown[]) => void) => void;
      };
      const client = new Redis(url, {
        connectTimeout: 1_500,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        lazyConnect: false,
      });
      client.on('error', (err: unknown) => {
        this.logger.warn(
          `Redis error (degrading to memory): ${err instanceof Error ? err.message : 'unknown'}`,
        );
        this.redisEnabled = false;
      });
      client.on('ready', () => {
        this.redisEnabled = true;
      });
      this.redis = client;
      this.redisEnabled = true;
    } catch {
      this.logger.warn('ioredis not available — using in-process config cache');
    }
  }

  async onModuleDestroy() {
    if (this.redis) {
      try {
        await Promise.race([
          this.redis.quit(),
          new Promise((resolve) => setTimeout(resolve, 500)),
        ]);
      } catch {
        /* ignore */
      }
      try {
        this.redis.disconnect();
      } catch {
        /* ignore */
      }
      this.redis = null;
    }
  }

  async getJson<T>(key: string): Promise<T | null> {
    try {
      if (this.redis && this.redisEnabled) {
        const raw = await this.redis.get(key);
        if (raw) return JSON.parse(raw) as T;
      }
    } catch {
      this.redisEnabled = false;
    }
    const hit = this.memory.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expiresAt) {
      this.memory.delete(key);
      return null;
    }
    try {
      return JSON.parse(hit.value) as T;
    } catch {
      return null;
    }
  }

  async setJson(key: string, value: unknown, ttlSeconds = 60): Promise<void> {
    const raw = JSON.stringify(value);
    this.memory.set(key, {
      value: raw,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
    try {
      if (this.redis && this.redisEnabled) {
        await this.redis.set(key, raw, 'EX', ttlSeconds);
      }
    } catch {
      this.redisEnabled = false;
    }
  }

  /**
   * Atomic counter shared across replicas (Redis INCRBY). Used for spend caps, where a
   * read-modify-write would undercount under concurrency. Without Redis it counts in-process
   * (per replica) — callers must treat that as a lower bound.
   */
  async incrBy(key: string, by: number, ttlSeconds: number): Promise<number> {
    const local = this.memoryCounter(key) + by;
    const prev = this.memory.get(key);
    this.memory.set(key, {
      value: JSON.stringify(local),
      expiresAt:
        prev && Date.now() <= prev.expiresAt
          ? prev.expiresAt
          : Date.now() + ttlSeconds * 1000,
    });
    try {
      if (this.redis && this.redisEnabled) {
        const n = await this.redis.incrby(key, by);
        if (n === by) await this.redis.expire(key, ttlSeconds);
        return Math.max(n, local);
      }
    } catch {
      this.redisEnabled = false;
    }
    return local;
  }

  async getCounter(key: string): Promise<number> {
    const local = this.memoryCounter(key);
    try {
      if (this.redis && this.redisEnabled) {
        const raw = await this.redis.get(key);
        return Math.max(Number(raw) || 0, local);
      }
    } catch {
      this.redisEnabled = false;
    }
    return local;
  }

  private memoryCounter(key: string): number {
    const hit = this.memory.get(key);
    if (!hit || Date.now() > hit.expiresAt) return 0;
    return Number(JSON.parse(hit.value)) || 0;
  }

  async invalidatePrefix(prefix: string): Promise<void> {
    for (const k of this.memory.keys()) {
      if (k.startsWith(prefix)) this.memory.delete(k);
    }
    // Redis SCAN not required for pilot — keys are short-TTL; bump configVersion invalidates logically.
  }

  widgetConfigKey(tenantSlug: string, locationSlug: string, version: number) {
    return `widget-config:v${version}:${tenantSlug}:${locationSlug}`;
  }

  isRedisHealthy(): boolean {
    return Boolean(this.redis && this.redisEnabled);
  }
}
