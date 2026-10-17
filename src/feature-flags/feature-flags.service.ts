import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Platform defaults are FAIL-CLOSED for dealership-specific capabilities.
 * Only explicitly enabled tenant/location flags turn features on, and
 * CapabilityService still verifies dependency chains before use.
 */
/**
 * Reserved flags: named so dealers/ops can see the roadmap, but FORCED OFF until the
 * capability is implemented and its dependencies exist. Setting them true has no effect.
 */
export const RESERVED_FLAGS: Record<string, string> = {
  voiceAi: 'voice_provider_not_configured',
  whatsapp: 'whatsapp_sender_not_configured',
  email: 'email_provider_not_selected',
  priceDropAlerts: 'requires_verified_inventory_change_events_and_messaging',
  crossStoreInventory: 'requires_dealer_group_cross_rooftop_permission_model',
};

export const PLATFORM_FEATURE_DEFAULTS: Record<string, boolean> = {
  chat: true, // widget shell; inventory/payments still gated
  /** Emergency switch: true = no LLM calls at all; deterministic concierge only. */
  llmDisabled: false,
  /**
   * Opt into longer customer replies. Default false = concise 1–2 sentence policy.
   * Tenants that historically relied on longer essays can set this true while migrating.
   */
  verboseReplies: false,
  /**
   * Optional daypart/weather/sports rapport. Default off; never invents live facts.
   * Weather/sports still require LiveInfoService verification when enabled.
   */
  contextualRapport: false,
  inventory: false,
  payments: false,
  vehicleCompare: false,
  savedVehicles: false,
  tekionIntegration: false,
  serviceAi: false,
  partsAi: false,
  financeCalculator: false,
  proactiveEngagement: false,
  multilingual: false,
  voiceAi: false,
  automatedFollowup: false,
  priceDropAlerts: false,
  crossStoreInventory: false,
  copilot: false,
  leadCapture: true,
  handoff: true,
  knowledge: false,
  uploads: false,
  appointments: false,
  sms: false,
  email: false,
  whatsapp: false,
};

@Injectable()
export class FeatureFlagsService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(
    tenantId: string,
    locationId?: string | null,
  ): Promise<Record<string, boolean>> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { featureFlags: true },
    });
    let locationFlags: Record<string, unknown> = {};
    if (locationId) {
      const loc = await this.prisma.location.findFirst({
        where: { id: locationId, tenantId },
        select: { featureFlags: true },
      });
      locationFlags = (loc?.featureFlags as Record<string, unknown>) ?? {};
    }
    const tenantFlags = (tenant?.featureFlags as Record<string, unknown>) ?? {};

    // Only Tekion DATA capabilities (CRM/DMS/scheduling/parts) open the integration flag.
    // A Tekion-hosted credit-application destination is not a CRM/DMS connection.
    const tekionLive = await this.prisma.integrationConnection.findFirst({
      where: {
        tenantId,
        provider: 'TEKION',
        enabled: true,
        liveReady: true,
        capability: { not: 'credit_application' },
      },
      select: { id: true },
    });

    const vautoLive = await this.prisma.integrationConnection.findFirst({
      where: {
        tenantId,
        provider: 'VAUTO',
        enabled: true,
        liveReady: true,
      },
      select: { id: true },
    });

    const merged: Record<string, boolean> = { ...PLATFORM_FEATURE_DEFAULTS };
    for (const [k, v] of Object.entries(tenantFlags)) {
      if (typeof v === 'boolean') merged[k] = v;
    }
    for (const [k, v] of Object.entries(locationFlags)) {
      if (typeof v === 'boolean') merged[k] = v;
    }

    // Hard gates: never expose live vendor features without liveReady connection
    if (!tekionLive) {
      merged.tekionIntegration = false;
    }
    for (const k of Object.keys(RESERVED_FLAGS)) merged[k] = false;
    void vautoLive; // vAuto health is reported by the integration, not a flag

    return merged;
  }

  /** Ops view: each flag's effective value with a reason code when forced off. */
  async explain(tenantId: string, locationId?: string | null) {
    const f = await this.resolve(tenantId, locationId);
    return Object.fromEntries(
      Object.entries(f).map(([k, v]) => [
        k,
        {
          enabled: v,
          reason:
            RESERVED_FLAGS[k] ??
            (k === 'tekionIntegration' && !v
              ? 'no_live_ready_tekion_connection'
              : undefined),
        },
      ]),
    );
  }

  /** Widget-safe subset — fail-closed (`=== true` only). */
  async forWidget(tenantId: string, locationId: string) {
    const f = await this.resolve(tenantId, locationId);
    return {
      chat: f.chat === true,
      inventory: f.inventory === true,
      payments: f.payments === true && f.financeCalculator === true,
      vehicleCompare: f.vehicleCompare === true,
      savedVehicles: f.savedVehicles === true,
      serviceAi: f.serviceAi === true,
      partsAi: f.partsAi === true,
      proactiveEngagement: f.proactiveEngagement === true,
      multilingual: f.multilingual === true,
      voiceAi: false,
      leadCapture: f.leadCapture === true,
      handoff: f.handoff === true,
      knowledge: f.knowledge === true,
      appointments: f.appointments === true,
    };
  }
}
