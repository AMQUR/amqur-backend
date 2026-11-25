import { Injectable, Logger } from '@nestjs/common';
import { CircuitBreakerService } from '../integrations/core/circuit-breaker.service';
import { PrismaService } from '../prisma/prisma.service';
import { CrmAdapterRegistry } from './adapters/adapter.registry';
import { AdapterBlockedError } from './adapters/crm-adapter';
import { CrmWfControlService } from './control.service';
import { envOn } from './crm-workforce.types';
import { CrmWfIntakeService } from './intake.service';
import { CRMWF_WORKER_ID, CrmWfQueueService } from './queue.service';
import { CrmWfSupervisorService } from './supervisor.service';

export type TickReport = {
  state: 'IDLE_DISABLED' | 'HALTED' | 'RUNNING';
  synced: number;
  claimed: number;
  outcomes: Record<string, number>;
};

/**
 * Autonomous execution engine — one tick. Runs in the worker process only when
 * CRM_WORKFORCE_ENABLED=true. Each tick: heartbeat → global stop check → per-rooftop connector
 * health + sync (behind a circuit breaker) → claim by priority → supervise.
 *
 * Throughput is bounded on purpose (CRM_WORKFORCE_BATCH, default 10 tasks per tick): capacity
 * to process is never permission to contact. Sending limits live in the compliance policy.
 */
@Injectable()
export class CrmWfEngineService {
  private readonly logger = new Logger('CrmWfEngine');
  private running = false;
  constructor(
    private readonly prisma: PrismaService,
    private readonly controls: CrmWfControlService,
    private readonly adapters: CrmAdapterRegistry,
    private readonly intake: CrmWfIntakeService,
    private readonly queue: CrmWfQueueService,
    private readonly supervisor: CrmWfSupervisorService,
    private readonly breaker: CircuitBreakerService,
  ) {}

  private async beat(state: string, detail: object = {}) {
    await this.prisma.crmWfHeartbeat.upsert({
      where: { workerId: CRMWF_WORKER_ID },
      create: {
        workerId: CRMWF_WORKER_ID,
        role: process.env.PROCESS_ROLE || 'all',
        state,
        detail,
      },
      update: { state, detail, lastBeatAt: new Date() },
    });
  }

  async tick(now = new Date()): Promise<TickReport> {
    const report: TickReport = {
      state: 'RUNNING',
      synced: 0,
      claimed: 0,
      outcomes: {},
    };
    if (this.running) return report;
    this.running = true;
    try {
      if (!envOn('CRM_WORKFORCE_ENABLED')) {
        await this.beat('IDLE_DISABLED');
        return { ...report, state: 'IDLE_DISABLED' };
      }
      if (
        envOn('CRM_WORKFORCE_EMERGENCY_STOP') ||
        (await this.controls.globalHalted())
      ) {
        await this.beat('HALTED');
        return { ...report, state: 'HALTED' };
      }
      report.synced = await this.syncConnectors(now);
      const batch = Math.max(
        1,
        Math.min(50, Number(process.env.CRM_WORKFORCE_BATCH || 10)),
      );
      const tasks = await this.queue.claim(batch);
      report.claimed = tasks.length;
      for (const t of tasks) {
        // A stop issued mid-batch takes effect before the next task, not after the batch.
        if (await this.controls.globalHalted()) {
          await this.queue.defer(
            t.id,
            new Date(Date.now() + 60_000),
            'halted:GLOBAL',
          );
          report.outcomes.deferred_halted =
            (report.outcomes.deferred_halted ?? 0) + 1;
          continue;
        }
        try {
          const o = await this.supervisor.process(t, now);
          report.outcomes[o] = (report.outcomes[o] ?? 0) + 1;
        } catch (e) {
          const msg = e instanceof Error ? e.message : 'unknown';
          const dead = await this.queue.fail(t.id, msg, t.attempts);
          report.outcomes[dead ? 'dead' : 'failed'] =
            (report.outcomes[dead ? 'dead' : 'failed'] ?? 0) + 1;
          this.logger.error(
            `task ${t.id} failed${dead ? ' (dead-lettered)' : ''}`,
          );
        }
      }
      await this.beat('RUNNING', { ...report, at: now.toISOString() });
      return report;
    } finally {
      this.running = false;
    }
  }

  /** Pull from enabled, authorized connectors. A failing connector trips its own breaker. */
  private async syncConnectors(now: Date): Promise<number> {
    const connectors = await this.prisma.crmWfConnector.findMany({
      where: { enabled: true },
    });
    let n = 0;
    for (const c of connectors) {
      const adapter = this.adapters.get(c.adapterKey);
      const key = `crmwf:${c.tenantId}:${c.locationId}:${c.adapterKey}`;
      if (!adapter || this.breaker.isOpen(key)) continue;
      if (adapter.requiresAuthorization && !c.authorizedAt) {
        await this.prisma.crmWfConnector.update({
          where: { id: c.id },
          data: {
            enabled: false,
            status: 'BLOCKED',
            statusReason: 'authorization_not_recorded',
          },
        });
        continue;
      }
      const scope = { tenantId: c.tenantId, locationId: c.locationId };
      try {
        const health = await adapter.health(scope);
        if (health.status !== 'READY') {
          // Session expired / disconnected / blocked: stop using it and say so. No retry storm.
          await this.prisma.crmWfConnector.update({
            where: { id: c.id },
            data: {
              status: health.status,
              statusReason: health.reason ?? null,
              lastHealthAt: now,
              enabled: health.status === 'DEGRADED',
            },
          });
          continue;
        }
        const records = await adapter.listLeads(scope);
        if (records.length)
          n += (await this.intake.ingest(scope, c.adapterKey, records, now))
            .received;
        this.breaker.recordSuccess(key);
        await this.prisma.crmWfConnector.update({
          where: { id: c.id },
          data: {
            status: 'READY',
            statusReason: health.reason ?? null,
            lastHealthAt: now,
            lastSyncAt: now,
            lastError: null,
          },
        });
      } catch (e) {
        this.breaker.recordFailure(key);
        const blocked = e instanceof AdapterBlockedError;
        await this.prisma.crmWfConnector.update({
          where: { id: c.id },
          data: {
            status: blocked ? 'BLOCKED' : 'DEGRADED',
            statusReason: blocked ? e.reason : 'sync_failed',
            lastHealthAt: now,
            lastError: (e instanceof Error ? e.message : 'unknown').slice(
              0,
              300,
            ),
            ...(blocked ? { enabled: false } : {}),
          },
        });
      }
    }
    return n;
  }
}
