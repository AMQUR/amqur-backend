import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { SchedulingProviderRegistry } from './scheduling-provider.registry';
import {
  SANDBOX_SCHEDULER_PROVIDER,
  SandboxSchedulingAdapter,
} from './sandbox-scheduling.adapter';

/**
 * Registers the SANDBOX scheduler outside production only. It is then still subject to the
 * registry's existing gates (an enabled + liveReady `appointments` IntegrationConnection for
 * the tenant/location) AND the per-tenant/location `sandboxScheduler` flag (default off).
 * In production nothing is constructed or registered, and the flag is forced off.
 */
@Injectable()
export class SandboxSchedulerRegistrar implements OnModuleInit {
  private readonly logger = new Logger(SandboxSchedulerRegistrar.name);

  constructor(
    private readonly registry: SchedulingProviderRegistry,
    private readonly flags: FeatureFlagsService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.registerIfAllowed();
  }

  /** Returns true when the sandbox adapter was registered. Never true in production. */
  registerIfAllowed(): boolean {
    if (process.env.NODE_ENV === 'production') return false;
    const adapter = new SandboxSchedulingAdapter(async (ctx, startUtc) => {
      const n = await this.prisma.appointmentProviderReceipt.count({
        where: {
          tenantId: ctx.tenantId,
          provider: SANDBOX_SCHEDULER_PROVIDER,
          status: 'CONFIRMED',
          confirmedStart: new Date(startUtc),
          NOT: { idempotencyKey: ctx.idempotencyKey },
          appointment: {
            locationId: ctx.locationId ?? null,
            status: 'CONFIRMED',
          },
        },
      });
      return n > 0;
    });
    this.registry.register(
      SANDBOX_SCHEDULER_PROVIDER,
      adapter,
      async (tenantId, locationId) =>
        process.env.NODE_ENV !== 'production' &&
        (await this.flags.resolve(tenantId, locationId)).sandboxScheduler ===
          true,
    );
    this.logger.warn(
      'SANDBOX scheduler registered (non-production). Demo bookings only — not a dealership scheduler.',
    );
    return true;
  }
}
