import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type {
  SchedulingContext,
  ServiceSchedulingProviderAdapter,
} from './scheduling-provider';
import { CircuitBreakerService } from '../integrations/core/circuit-breaker.service';

export type ResolvedScheduler = {
  adapter: ServiceSchedulingProviderAdapter;
  connectionId: string;
  provider: string;
  mode: 'sandbox' | 'production';
};

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly breaker: CircuitBreakerService,
  ) {}

  register(provider: string, adapter: ServiceSchedulingProviderAdapter): void {
    this.adapters.set(provider, adapter);
  }

  registeredProviders(): string[] {
    return [...this.adapters.keys()];
  }

  async resolve(
    tenantId: string,
    locationId?: string | null,
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
      const cfg = (c.config ?? {}) as Record<string, unknown>;
      return {
        adapter,
        connectionId: c.id,
        provider: c.provider,
        mode: cfg.mode === 'production' ? 'production' : 'sandbox',
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
  ): SchedulingContext {
    return {
      tenantId,
      locationId,
      connectionId: r.connectionId,
      mode: r.mode,
      timeoutMs: 8000,
      idempotencyKey,
      correlationId,
    };
  }
}
