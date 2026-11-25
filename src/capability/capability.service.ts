import {
  ADF_FEATURE_FLAG,
  deliveryTier,
  effectiveMode,
  readLeadDeliveryEnv,
} from '../integrations/adf/lead-delivery-gates';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { isProductionTier } from '../config/deployment-tier';

export type CapabilityName =
  | 'chat'
  | 'inventory'
  | 'payments'
  | 'service'
  | 'parts'
  | 'handoff'
  | 'vehicleCompare'
  | 'savedVehicles'
  | 'appointments'
  | 'leadCapture'
  | 'knowledge'
  | 'sms';

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
    private readonly flags_: FeatureFlagsService,
  ) {}

  private readonly deliveryReady = new Map<
    string,
    { ok: boolean; until: number }
  >();

  /**
   * Can a lead captured for this store actually reach the dealership? Outside the production
   * tier this is always true (sandbox and tests). In production it needs the CRM webhook, or
   * live ADF sending switched on, the store's `adfLeadDelivery` flag, and a SALES route that is
   * PRODUCTION, enabled, verified and production-enabled. Cached for 30 s.
   */
  async leadDeliveryReady(
    tenantId: string,
    locationId: string | null | undefined,
    adfFlag: boolean,
    env: Record<string, string | undefined> = process.env,
    now: number = Date.now(),
  ): Promise<boolean> {
    const d = readLeadDeliveryEnv(env);
    if (deliveryTier(d) !== 'production') return true;
    if ((env.CRM_WEBHOOK_URL ?? '').trim()) return true;
    if (effectiveMode(d) !== 'live' || !adfFlag) return false;
    const key = `${tenantId}:${locationId ?? '*'}`;
    const hit = this.deliveryReady.get(key);
    if (hit && hit.until > now) return hit.ok;
    const route = await this.prisma.leadDeliveryRoute
      .findFirst({
        where: {
          tenantId,
          ...(locationId ? { locationId } : {}),
          department: 'SALES',
          environment: 'PRODUCTION',
          enabled: true,
          verified: true,
          productionEnabled: true,
        },
        select: { id: true },
      })
      .catch(() => null);
    if (this.deliveryReady.size > 500) this.deliveryReady.clear();
    this.deliveryReady.set(key, { ok: !!route, until: now + 30_000 });
    return !!route;
  }

  /** Raw effective flags (for non-capability switches such as llmDisabled). */
  flags(tenantId: string, locationId: string | null | undefined) {
    return this.flags_.resolve(tenantId, locationId);
  }

  async check(
    tenantId: string,
    locationId: string | null | undefined,
    capability: CapabilityName,
  ): Promise<CapabilityResult> {
    const f = await this.flags_.resolve(tenantId, locationId);
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

      case 'appointments':
        // Appointment REQUESTS (never confirmations) — explicit opt-in per dealership.
        if (f.appointments !== true) {
          return unavailable(
            'appointments_flag_off',
            'I can’t take appointment requests here yet. I can connect you with a team member instead.',
          );
        }
        return { allowed: true };

      case 'leadCapture':
        if (f.leadCapture !== true) {
          return unavailable(
            'lead_capture_off',
            'I can’t record contact requests here right now. Please call the dealership.',
          );
        }
        // Production never collects a lead nobody would receive: the store needs a verified,
        // production-enabled delivery route (or the CRM webhook) before contact details are
        // taken from the public.
        if (
          !(await this.leadDeliveryReady(
            tenantId,
            locationId,
            (f as Record<string, unknown>)[ADF_FEATURE_FLAG] === true,
          ))
        ) {
          return unavailable(
            'lead_delivery_not_ready',
            'I can’t record contact requests here right now. Please call the dealership.',
          );
        }
        return { allowed: true };

      case 'knowledge':
        if (f.knowledge !== true) {
          return unavailable(
            'knowledge_flag_off',
            'I don’t have the dealership’s policy documents available here.',
          );
        }
        return { allowed: true };

      case 'sms':
        if (f.sms !== true) {
          return unavailable(
            'sms_flag_off',
            'Texting isn’t available from this chat yet.',
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

    // Synthetic fixtures never make the *production* deployment tier "ready".
    // Hosted staging (NODE_ENV=production + DEPLOYMENT_TIER=staging) may use them.
    const hideSynthetic = isProductionTier()
      ? { NOT: { source: 'synthetic_demo' as const } }
      : {};

    const vehicleCount = await this.prisma.vehicle.count({
      where: {
        tenantId,
        ...(locationId ? { locationId } : {}),
        status: { in: ['AVAILABLE', 'IN_TRANSIT', 'HOLD'] },
        ...hideSynthetic,
      },
    });

    if (vehicleCount > 0) {
      const fresh = await this.prisma.vehicle.count({
        where: {
          tenantId,
          ...(locationId ? { locationId } : {}),
          status: { in: ['AVAILABLE', 'IN_TRANSIT', 'HOLD'] },
          freshnessState: { in: ['FRESH', 'DEGRADED'] },
          ...hideSynthetic,
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
