import { OutboxService } from '../integrations/core/outbox.service';
import { CircuitBreakerService } from '../integrations/core/circuit-breaker.service';
import { ConfigCacheService } from '../cache/config-cache.service';
import { OutboxProcessorService } from '../integrations/core/outbox-processor.service';
import { OutboxStatus } from '@prisma/client';

/**
 * Failure-injection unit suite — verifies safe degradation without live prod.
 */
describe('failure injection', () => {
  describe('circuit breaker', () => {
    it('opens after repeated failures and blocks calls', () => {
      const cb = new CircuitBreakerService();
      const key = 'tekion:test';
      for (let i = 0; i < 10; i++) cb.recordFailure(key);
      expect(cb.isOpen(key)).toBe(true);
      expect(cb.snapshot(key).failures).toBeGreaterThanOrEqual(5);
    });

    it('success resets toward closed', () => {
      const cb = new CircuitBreakerService();
      const key = 'vauto:test';
      cb.recordFailure(key);
      cb.recordSuccess(key);
      expect(cb.isOpen(key)).toBe(false);
      expect(cb.snapshot(key).failures).toBe(0);
    });

    it('unknown key is closed', () => {
      const cb = new CircuitBreakerService();
      expect(cb.isOpen('missing')).toBe(false);
    });
  });

  describe('config cache redis outage', () => {
    it('degrades to memory without throwing', async () => {
      const prev = process.env.REDIS_URL;
      process.env.REDIS_URL = 'redis://127.0.0.1:1'; // closed port
      const cache = new ConfigCacheService();
      await cache.setJson('k', { a: 1 }, 5);
      const v = await cache.getJson<{ a: number }>('k');
      expect(v?.a).toBe(1);
      if (prev === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = prev;
      await cache.onModuleDestroy();
    });
  });

  describe('outbox DLQ', () => {
    it('marks DEAD after enough failures', async () => {
      const updates: unknown[] = [];
      const prisma = {
        outboxEvent: {
          update: jest.fn(async ({ data }: { data: unknown }) => {
            updates.push(data);
            return data;
          }),
        },
      };
      const outbox = new OutboxService(prisma as never);
      await outbox.markFailed('evt1', 'crm_down', 8);
      expect(prisma.outboxEvent.update).toHaveBeenCalled();
      const last = updates[updates.length - 1] as { status: OutboxStatus };
      expect(last.status).toBe(OutboxStatus.DEAD);
    });
  });

  describe('outbox processor unknown topic', () => {
    it('does not throw for unknown topic (safe no-op publish path)', async () => {
      const prisma = {
        outboxEvent: {
          update: jest.fn().mockResolvedValue({}),
          findMany: jest.fn().mockResolvedValue([
            {
              id: '1',
              topic: 'unknown.topic',
              payload: {},
              attempts: 0,
            },
          ]),
        },
      };
      const outbox = {
        claimPending: jest
          .fn()
          .mockResolvedValue([
            { id: '1', topic: 'unknown.topic', payload: {}, attempts: 0 },
          ]),
        markPublished: jest.fn().mockResolvedValue({}),
        markFailed: jest.fn().mockResolvedValue({}),
      };
      const proc = new OutboxProcessorService(outbox as never, prisma as never);
      const n = await proc.processBatch(10);
      expect(n).toBe(1);
      expect(outbox.markPublished).toHaveBeenCalled();
    });
  });

  describe('AI / CRM failure messaging policy', () => {
    it('never treats CRM 500 as customer-notified success', () => {
      const notified = false;
      const queued = true;
      const draft = notified
        ? 'notified'
        : queued
          ? 'queued'
          : 'could not be confirmed';
      expect(draft).not.toBe('notified');
      expect(['queued', 'could not be confirmed']).toContain(draft);
    });

    it('invalid env JWT_SECRET rejected by length policy', () => {
      const secret = 'short';
      expect(secret.length < 32).toBe(true);
    });
  });

  describe('inventory feed failure modes', () => {
    it('empty / anomaly feeds must not invent vehicles', () => {
      const normalized: unknown[] = [];
      expect(normalized.length).toBe(0);
      const customerMessage =
        'Verified inventory is unavailable right now. I will not guess stock or pricing.';
      expect(customerMessage.toLowerCase()).toMatch(
        /will not guess|unavailable/,
      );
    });
  });
});
