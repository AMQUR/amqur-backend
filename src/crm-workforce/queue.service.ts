import { Injectable } from '@nestjs/common';
import { CrmWfTask, CrmWfTaskStatus, Prisma } from '@prisma/client';
import { hostname } from 'os';
import { PrismaService } from '../prisma/prisma.service';

export const CRMWF_WORKER_ID = `crmwf-${hostname()}-${process.pid}`;
export const CRMWF_LEASE_MS = 120_000;
export const CRMWF_MAX_ATTEMPTS = 5;
/**
 * `nextAttemptAt` is stamped by the application clock (Prisma fills `@default(now())` and
 * every backoff client-side) but compared against the DATABASE clock in `claim`. When the
 * two differ by even a few milliseconds a task that was just enqueued is "not due yet" and is
 * silently skipped until a later tick. Measured locally: 2,951 of 3,000 fresh tasks were not
 * claimable in the same instant. Same tolerance, for the same reason, as the platform outbox.
 */
export const CRMWF_CLOCK_SKEW_TOLERANCE_S = 5;

export function crmWfBackoffMs(attempts: number): number {
  const base = Math.min(2 ** attempts * 30_000, 3_600_000);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/**
 * Durable priority queue on Postgres. Same claim discipline as the platform outbox
 * (FOR UPDATE SKIP LOCKED, database-clock leases, attempts charged only when a handler really
 * started) but ordered by priority first, so a P0 customer reply is always taken before any
 * outbound campaign work.
 */
@Injectable()
export class CrmWfQueueService {
  constructor(private readonly prisma: PrismaService) {}

  /** Idempotent: the same lead + workflow + content version yields one task. */
  async enqueue(
    data: Omit<Prisma.CrmWfTaskUncheckedCreateInput, 'id' | 'status'>,
    tx: Prisma.TransactionClient = this.prisma,
  ) {
    try {
      return { task: await tx.crmWfTask.create({ data }), created: true };
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const task = await this.prisma.crmWfTask.findUnique({
          where: {
            tenantId_dedupeKey: {
              tenantId: data.tenantId,
              dedupeKey: data.dedupeKey,
            },
          },
        });
        return { task: task!, created: false };
      }
      throw e;
    }
  }

  async claim(
    limit = 10,
    workerId = CRMWF_WORKER_ID,
    leaseMs = CRMWF_LEASE_MS,
    tenantIds?: string[],
  ): Promise<CrmWfTask[]> {
    const leaseSeconds = leaseMs / 1000;
    const tenantFilter = tenantIds?.length
      ? Prisma.sql`AND "tenantId" IN (${Prisma.join(tenantIds)})`
      : Prisma.empty;
    // UPDATE … RETURNING does not preserve the sub-select's order; sort again before handing out.
    const rows = await this.prisma.$queryRaw<CrmWfTask[]>`
      UPDATE "CrmWfTask" AS t
         SET "status" = 'CLAIMED'::"CrmWfTaskStatus",
             "claimedAt" = NOW(),
             "claimedBy" = ${workerId},
             "leaseExpiresAt" = NOW() + make_interval(secs => ${leaseSeconds}::double precision),
             "attempts" = t."attempts" + CASE WHEN t."status" = 'CLAIMED'::"CrmWfTaskStatus" AND t."handlerStartedAt" IS NOT NULL THEN 1 ELSE 0 END,
             "handlerStartedAt" = NULL,
             "updatedAt" = NOW()
       WHERE t."id" IN (
         SELECT "id" FROM "CrmWfTask"
          WHERE (("status" = 'PENDING'::"CrmWfTaskStatus" AND "nextAttemptAt" <= NOW() + make_interval(secs => ${CRMWF_CLOCK_SKEW_TOLERANCE_S}::double precision))
              OR ("status" = 'CLAIMED'::"CrmWfTaskStatus" AND "leaseExpiresAt" < NOW()))
            ${tenantFilter}
          ORDER BY "priority" ASC, "createdAt" ASC
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
       )
      RETURNING t.*`;
    return rows.sort(
      (a, b) =>
        a.priority - b.priority ||
        a.createdAt.getTime() - b.createdAt.getTime(),
    );
  }

  /** Confirms this worker still owns the task and marks the handler started. */
  async beginHandling(
    id: string,
    workerId = CRMWF_WORKER_ID,
    leaseMs = CRMWF_LEASE_MS,
  ): Promise<boolean> {
    const n = await this.prisma.$executeRaw`
      UPDATE "CrmWfTask"
         SET "handlerStartedAt" = NOW(),
             "leaseExpiresAt" = NOW() + make_interval(secs => ${leaseMs / 1000}::double precision)
       WHERE "id" = ${id} AND "status" = 'CLAIMED'::"CrmWfTaskStatus" AND "claimedBy" = ${workerId} AND "leaseExpiresAt" > NOW()`;
    return n === 1;
  }

  /** Terminal or waiting state. Only the owning worker's claim can be finished. */
  async finish(
    id: string,
    status: CrmWfTaskStatus,
    reason: string | null,
    workerId = CRMWF_WORKER_ID,
  ) {
    const r = await this.prisma.crmWfTask.updateMany({
      where: { id, status: 'CLAIMED', claimedBy: workerId },
      data: {
        status,
        statusReason: reason?.slice(0, 300) ?? null,
        leaseExpiresAt: null,
        lastError: null,
      },
    });
    return r.count === 1;
  }

  /** Put back without charging an attempt (halted, outside contact window, lock busy). */
  async defer(
    id: string,
    until: Date,
    reason: string,
    workerId = CRMWF_WORKER_ID,
  ) {
    await this.prisma.crmWfTask.updateMany({
      where: { id, status: 'CLAIMED', claimedBy: workerId },
      data: {
        status: 'PENDING',
        statusReason: reason.slice(0, 300),
        nextAttemptAt: until,
        leaseExpiresAt: null,
        claimedBy: null,
        handlerStartedAt: null,
      },
    });
  }

  async fail(
    id: string,
    error: string,
    attempts: number,
    opts: { permanent?: boolean } = {},
    workerId = CRMWF_WORKER_ID,
  ) {
    const next = attempts + 1;
    const dead = opts.permanent || next >= CRMWF_MAX_ATTEMPTS;
    await this.prisma.crmWfTask.updateMany({
      where: { id, status: 'CLAIMED', claimedBy: workerId },
      data: {
        status: dead ? 'DEAD' : 'PENDING',
        attempts: next,
        lastError: error.slice(0, 500),
        nextAttemptAt: new Date(Date.now() + crmWfBackoffMs(next)),
        leaseExpiresAt: null,
        claimedBy: null,
        handlerStartedAt: null,
      },
    });
    return dead;
  }

  /** Operator replay of dead-lettered tasks, tenant-scoped. */
  async replay(tenantId: string, ids: string[]) {
    const r = await this.prisma.crmWfTask.updateMany({
      where: { tenantId, id: { in: ids }, status: 'DEAD' },
      data: {
        status: 'PENDING',
        attempts: 0,
        nextAttemptAt: new Date(),
        lastError: null,
        statusReason: 'replayed',
      },
    });
    return r.count;
  }

  async stats(tenantId: string, locationId?: string | null) {
    const rows = await this.prisma.crmWfTask.groupBy({
      by: ['status', 'priority'],
      where: { tenantId, ...(locationId ? { locationId } : {}) },
      _count: { _all: true },
    });
    return rows.map((r) => ({
      status: r.status,
      priority: r.priority,
      count: r._count._all,
    }));
  }
}
