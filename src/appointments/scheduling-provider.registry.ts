import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type {
  SchedulingContext,
  SchedulingDepartment,
  ServiceSchedulingProviderAdapter,
} from './scheduling-provider';
import { CircuitBreakerService } from '../integrations/core/circuit-breaker.service';

export type ResolvedScheduler = {
  adapter: ServiceSchedulingProviderAdapter;
  connectionId: string;
  provider: string;
  mode: 'sandbox' | 'production';
  /** Demo scheduler (adapter-declared). Never a real dealership booking. */
  sandbox: boolean;
  displayName: string;
};

/** Extra per-tenant/location gate an adapter must pass on every resolve (fail-closed). */
export type SchedulerGate = (
  tenantId: string,
  locationId: string | null | undefined,
) => Promise<boolean>;

/**
 * Resolves the authoritative scheduler for a tenant/location from IntegrationConnection
 * (capability=appointments, enabled AND liveReady). No adapter is ever selected merely
 * because code exists — the connection must be explicitly enabled by an operator after
 * the vendor contract is verified. Google Calendar is only used when a store explicitly
 * configures it; it never overrides a DMS scheduler.
 */
@Injectable()
export class SchedulingProviderRegistry {
  private readonly logger = new Logger(SchedulingProviderRegistry.name);
  private readonly adapters = new Map<
    string,
    ServiceSchedulingProviderAdapter
  >();
  private readonly gates = new Map<string, SchedulerGate>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly breaker: CircuitBreakerService,
  ) {}

  register(
    provider: string,
    adapter: ServiceSchedulingProviderAdapter,
    gate?: SchedulerGate,
  ): void {
    // A sandbox scheduler can never be registered in production, whoever asks.
    if (adapter.sandbox && process.env.NODE_ENV === 'production') {
      throw new Error('sandbox_scheduler_forbidden_in_production');
    }
    // An adapter that can book must be able to find and cancel a booking by idempotency key,
    // otherwise a lost response would leave an orphan booking nobody can compensate.
    if (
      adapter.capabilities().create &&
      (typeof adapter.findByIdempotencyKey !== 'function' ||
        typeof adapter.cancelByIdempotencyKey !== 'function')
    ) {
      throw new Error('scheduler_adapter_missing_idempotent_lookup');
    }
    this.adapters.set(provider, adapter);
    if (gate) this.gates.set(provider, gate);
    else this.gates.delete(provider);
  }

  adapterFor(provider: string): ServiceSchedulingProviderAdapter | undefined {
    return this.adapters.get(provider);
  }

  registeredProviders(): string[] {
    return [...this.adapters.keys()];
  }

  async resolve(
    tenantId: string,
    locationId?: string | null,
    department?: SchedulingDepartment,
  ): Promise<ResolvedScheduler | null> {
    const conns = await this.prisma.integrationConnection.findMany({
      where: {
        tenantId,
        capability: 'appointments',
        enabled: true,
        liveReady: true,
        OR: locationId
          ? [{ locationId }, { locationId: null }]
          : [{ locationId: null }],
      },
      orderBy: { updatedAt: 'desc' },
    });
    // DMS scheduler (non-calendar) wins over calendar fallback; location-specific wins over tenant-wide.
    const ranked = conns.sort((a, b) => {
      const cal = (p: string) => (p === 'GOOGLE_CALENDAR' ? 1 : 0);
      if (cal(a.provider) !== cal(b.provider))
        return cal(a.provider) - cal(b.provider);
      return (a.locationId ? 0 : 1) - (b.locationId ? 0 : 1);
    });
    for (const c of ranked) {
      const adapter = this.adapters.get(c.provider);
      if (!adapter) {
        this.logger.warn(
          `appointments connection ${c.id} provider=${c.provider} enabled but no adapter registered — ignored`,
        );
        continue;
      }
      if (this.breaker.isOpen(`scheduler:${c.id}`)) continue;
      if (adapter.sandbox && process.env.NODE_ENV === 'production') continue;
      const gate = this.gates.get(c.provider);
      if (gate && !(await gate(tenantId, locationId).catch(() => false)))
        continue;
      const cfg = (c.config ?? {}) as Record<string, unknown>;
      // Optional per-connection department allow-list (absent = every department).
      if (
        department &&
        Array.isArray(cfg.departments) &&
        !cfg.departments.includes(department)
      )
        continue;
      return {
        adapter,
        connectionId: c.id,
        provider: c.provider,
        mode: cfg.mode === 'production' ? 'production' : 'sandbox',
        sandbox: adapter.sandbox === true,
        displayName: adapter.displayName ?? c.provider,
      };
    }
    return null;
  }

  context(
    r: ResolvedScheduler,
    tenantId: string,
    locationId: string | null | undefined,
    idempotencyKey: string,
    correlationId: string,
    now?: Date,
  ): SchedulingContext {
    return {
      tenantId,
      locationId,
      connectionId: r.connectionId,
      mode: r.mode,
      timeoutMs: 8000,
      idempotencyKey,
      correlationId,
      ...(now ? { now } : {}),
    };
  }
}
