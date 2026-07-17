import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';

export type CapabilityName =
  | 'chat'
  | 'inventory'
  | 'payments'
  | 'service'
  | 'parts'
  | 'handoff'
  | 'vehicleCompare'
  | 'savedVehicles';

export type CapabilityResult = {
  allowed: boolean;
  reason?: string;
  customerMessage?: string;
};

/**
 * Fail-closed capability gating: a feature is allowed only when the flag is
 * explicitly enabled AND its dependency chain is ready.
 */
@Injectable()
export class CapabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: FeatureFlagsService,
  ) {}

  async check(
    tenantId: string,
    locationId: string | null | undefined,
    capability: CapabilityName,
  ): Promise<CapabilityResult> {
    const f = await this.flags.resolve(tenantId, locationId);
    const unavailable = (
      reason: string,
      customerMessage: string,
    ): CapabilityResult => ({
      allowed: false,
      reason,
      customerMessage,
    });

    switch (capability) {
      case 'chat':
        if (f.chat !== true) {
          return unavailable(
            'chat_disabled',
            'Chat is not available for this dealership right now. Please call the store for help.',
          );
        }
        return { allowed: true };

      case 'inventory': {
        if (f.inventory !== true) {
          return unavailable(
            'inventory_flag_off',
            'Live inventory search is not enabled for this dealership. I can connect you with a team member instead.',
          );
        }
        const ready = await this.inventoryChainReady(tenantId, locationId);
        if (!ready.ok) {
          return unavailable(
            ready.reason,
            'Verified inventory is unavailable right now. I will not guess stock or pricing — I can connect you with a team member.',
          );
        }
        return { allowed: true };
      }

      case 'payments': {
        if (f.payments !== true || f.financeCalculator !== true) {
          return unavailable(
            'payments_flag_off',
            'Payment estimates are not enabled for this dealership. A team member can discuss financing options.',
          );
        }
        const inv = await this.check(tenantId, locationId, 'inventory');
        if (!inv.allowed) {
          return unavailable(
            'payments_needs_inventory',
            'I cannot provide payment estimates without verified vehicle pricing from inventory.',
          );
        }
        return { allowed: true };
      }

      case 'service':
        if (f.serviceAi !== true) {
          return unavailable(
            'service_flag_off',
            'Service scheduling assistance is not enabled. Please contact the service department directly, or ask for a team member.',
          );
        }
        return { allowed: true };

      case 'parts':
        if (f.partsAi !== true) {
          return unavailable(
            'parts_flag_off',
            'Parts assistance is not enabled. I will not invent fitment or pricing — ask for a parts specialist.',
          );
        }
        return { allowed: true };

      case 'handoff':
        // Handoff capture is always allowed when chat is on; delivery is separate.
        if (f.chat !== true) {
          return unavailable(
            'chat_disabled',
            'I cannot take a handoff request while chat is disabled. Please call the dealership.',
          );
        }
        return { allowed: true };

      case 'vehicleCompare':
        if (f.vehicleCompare !== true) {
          return unavailable(
            'compare_flag_off',
            'Vehicle compare is not enabled for this dealership.',
          );
        }
        return this.check(tenantId, locationId, 'inventory');

      case 'savedVehicles':
        if (f.savedVehicles !== true) {
          return unavailable(
            'saved_flag_off',
            'Saving vehicles is not enabled for this dealership.',
          );
        }
        return { allowed: true };

      default:
        return unavailable('unknown', 'That feature is unavailable.');
    }
  }

  private async inventoryChainReady(
    tenantId: string,
    locationId?: string | null,
  ): Promise<{ ok: boolean; reason: string }> {
    const location = locationId
      ? await this.prisma.location.findFirst({
          where: { id: locationId, tenantId },
          select: {
            inventoryFeedUrl: true,
            inventoryFreshnessHours: true,
          },
        })
      : null;

    const vehicleCount = await this.prisma.vehicle.count({
      where: {
        tenantId,
        ...(locationId ? { locationId } : {}),
        status: { in: ['AVAILABLE', 'IN_TRANSIT', 'HOLD'] },
      },
    });

    if (vehicleCount > 0) {
      const fresh = await this.prisma.vehicle.count({
        where: {
          tenantId,
          ...(locationId ? { locationId } : {}),
          status: { in: ['AVAILABLE', 'IN_TRANSIT', 'HOLD'] },
          freshnessState: { in: ['FRESH', 'DEGRADED'] },
        },
      });
      if (fresh > 0) return { ok: true, reason: 'vehicles_present' };
      return { ok: false, reason: 'inventory_stale' };
    }

    if (location?.inventoryFeedUrl) {
      return { ok: false, reason: 'feed_configured_but_empty' };
    }

    const vauto = await this.prisma.integrationConnection.findFirst({
      where: {
        tenantId,
        provider: 'VAUTO',
        enabled: true,
        liveReady: true,
      },
      select: { id: true },
    });
    if (vauto) return { ok: false, reason: 'vauto_enabled_but_no_vehicles' };

    return { ok: false, reason: 'no_inventory_source' };
  }
}
