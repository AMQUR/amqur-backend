import { Injectable } from '@nestjs/common';
import { hostname } from 'os';
import { PrismaService } from '../../prisma/prisma.service';
import { OutboxEvent, OutboxStatus, Prisma } from '@prisma/client';

export const OUTBOX_MAX_ATTEMPTS = 8;
export const OUTBOX_LEASE_MS = 2 * 60_000;
/**
 * Rows are stamped by app hosts (Prisma client-side now()) but claimed against the DB clock.
 * A small tolerance prevents freshly-enqueued events from being invisible under host/DB skew.
 * Retry backoff is computed on the DB clock (see markFailed), so this never shortens backoff
 * by more than the tolerance.
 */
export const OUTBOX_CLOCK_SKEW_TOLERANCE_S = 5;

/** Stable worker identity for lease ownership / debugging. */
export const OUTBOX_WORKER_ID = `${hostname()}:${process.pid}`;

export function backoffMs(attempts: number): number {
  // 2s, 4s, 8s … capped at 1h, with ±20% jitter to avoid thundering herds
  const base = Math.min(3_600_000, 2 ** attempts * 1000);
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.max(1000, Math.round(base + jitter));
}

@Injectable()
export class OutboxService {
  constructor(private readonly prisma: PrismaService) {}

  async enqueue(params: {
    tenantId: string;
    topic: string;
    payload: Record<string, unknown>;
    idempotencyKey?: string;
    tx?: Prisma.TransactionClient;
    /** Delay delivery (scheduled campaign steps, quiet-hours deferral). */
    availableAt?: Date;
  }) {
    const db = params.tx ?? this.prisma;
    if (params.idempotencyKey) {
      const existing = await db.outboxEvent.findUnique({
        where: {
          tenantId_idempotencyKey: {
            tenantId: params.tenantId,
            idempotencyKey: params.idempotencyKey,
          },
        },
      });
      if (existing) return existing;
    }
    try {
      return await db.outboxEvent.create({
        data: {
          tenantId: params.tenantId,
          topic: params.topic,
          payload: params.payload as Prisma.InputJsonValue,
          idempotencyKey: params.idempotencyKey,
          status: OutboxStatus.PENDING,
          ...(params.availableAt ? { nextAttemptAt: params.availableAt } : {}),
        },
      });
    } catch (e: unknown) {
      // Concurrent enqueue with the same idempotency key — return the winner.
      if (
        params.idempotencyKey &&
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const winner = await db.outboxEvent.findUnique({
          where: {
            tenantId_idempotencyKey: {
              tenantId: params.tenantId,
              idempotencyKey: params.idempotencyKey,
            },
          },
        });
        if (winner) return winner;
      }
      throw e;
    }
  }

  /**
   * Atomically claim due events for THIS worker. Uses a single UPDATE … WHERE id IN
   * (SELECT … FOR UPDATE SKIP LOCKED) so concurrent workers can never claim the same row.
   * Rows stuck in PROCESSING with an expired lease (crashed worker) are reclaimed.
   */
  async claimPending(
    limit = 50,
    workerId = OUTBOX_WORKER_ID,
    leaseMs = OUTBOX_LEASE_MS,
  ): Promise<OutboxEvent[]> {
    // Lease expiry uses the DATABASE clock (same clock used for reclaim) so skew between
    // worker hosts can never make a live lease look expired or a dead one look alive.
    const leaseSeconds = leaseMs / 1000;
    return this.prisma.$queryRaw<OutboxEvent[]>`
      UPDATE "OutboxEvent" AS o
         SET "status" = 'PROCESSING'::"OutboxStatus",
             "claimedAt" = NOW(),
             "claimedBy" = ${workerId},
             "leaseExpiresAt" = NOW() + make_interval(secs => ${leaseSeconds}::double precision),
             "updatedAt" = NOW()
       WHERE o."id" IN (
         SELECT "id" FROM "OutboxEvent"
          WHERE ("status" = 'PENDING'::"OutboxStatus" AND "nextAttemptAt" <= NOW() + make_interval(secs => ${OUTBOX_CLOCK_SKEW_TOLERANCE_S}::double precision))
             OR ("status" = 'PROCESSING'::"OutboxStatus" AND "leaseExpiresAt" < NOW())
          ORDER BY "createdAt" ASC
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
       )
      RETURNING o.*`;
  }

  /** Only the lease holder may complete an event (guards against a slow worker after lease expiry). */
  async markPublished(id: string, workerId = OUTBOX_WORKER_ID, note?: string) {
    return this.prisma.outboxEvent.updateMany({
      where: { id, status: OutboxStatus.PROCESSING, claimedBy: workerId },
      data: {
        status: OutboxStatus.PUBLISHED,
        publishedAt: new Date(),
        leaseExpiresAt: null,
        lastError: note ?? null,
      },
    });
  }

  async markFailed(
    id: string,
    error: string,
    attempts: number,
    opts: { workerId?: string; permanent?: boolean } = {},
  ) {
    const dead = opts.permanent || attempts >= OUTBOX_MAX_ATTEMPTS;
    const delaySeconds = backoffMs(attempts) / 1000;
    const count = await this.prisma.$executeRaw`
      UPDATE "OutboxEvent"
         SET "status" = ${dead ? 'DEAD' : 'PENDING'}::"OutboxStatus",
             "attempts" = ${attempts},
             "lastError" = ${error.slice(0, 500)},
             "leaseExpiresAt" = NULL,
             "nextAttemptAt" = NOW() + make_interval(secs => ${delaySeconds}::double precision),
             "updatedAt" = NOW()
       WHERE "id" = ${id}
         AND "status" = 'PROCESSING'::"OutboxStatus"
         AND "claimedBy" = ${opts.workerId ?? OUTBOX_WORKER_ID}`;
    return { count };
  }

  /** Staff/ops replay of DEAD events (audited by caller). */
  async replay(tenantId: string, ids: string[]) {
    return this.prisma.outboxEvent.updateMany({
      where: { tenantId, id: { in: ids }, status: OutboxStatus.DEAD },
      data: {
        status: OutboxStatus.PENDING,
        attempts: 0,
        nextAttemptAt: new Date(),
        lastError: null,
      },
    });
  }

  async stats(tenantId?: string) {
    const rows = await this.prisma.outboxEvent.groupBy({
      by: ['status'],
      where: tenantId ? { tenantId } : undefined,
      _count: { _all: true },
    });
    return Object.fromEntries(rows.map((r) => [r.status, r._count._all]));
  }
}
