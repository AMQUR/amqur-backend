import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Platform defaults are FAIL-CLOSED for dealership-specific capabilities.
 * Only explicitly enabled tenant/location flags turn features on, and
 * CapabilityService still verifies dependency chains before use.
 */
export const PLATFORM_FEATURE_DEFAULTS: Record<string, boolean> = {
  chat: true, // widget shell; inventory/payments still gated
  inventory: false,
  payments: false,
  vehicleCompare: false,
  savedVehicles: false,
  tekionIntegration: false,
  vAutoFeed: false,
  serviceAi: false,
  partsAi: false,
  financeCalculator: false,
  proactiveEngagement: false,
  multilingual: false,
  voiceAi: false,
  automatedFollowup: false,
  priceDropAlerts: false,
  crossStoreInventory: false,
  leadScoring: false,
  copilot: false,
  leadCapture: true,
  handoff: true,
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

    const tekionLive = await this.prisma.integrationConnection.findFirst({
      where: {
        tenantId,
        provider: 'TEKION',
        enabled: true,
        liveReady: true,
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
    if (!vautoLive && merged.vAutoFeed === true) {
      // Allow feed URL on Location without IntegrationConnection, but do not
      // claim vAuto live integration health unless connection is liveReady.
      // Flag may still be true for feed-based inventory — CapabilityService checks data.
    }
    if (!tekionLive && !vautoLive) {
      // no-op; kept for clarity
    }

    // Voice never claimed until a live voice provider is wired
    merged.voiceAi = false;

    return merged;
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
    };
  }
}
