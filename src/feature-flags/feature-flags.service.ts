import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Platform defaults — tenant/location JSON can override. Partially configured live features stay false. */
export const PLATFORM_FEATURE_DEFAULTS: Record<string, boolean> = {
  chat: true,
  inventory: true,
  payments: true,
  vehicleCompare: true,
  savedVehicles: true,
  tekionIntegration: false,
  vAutoFeed: true,
  serviceAi: true,
  partsAi: true,
  financeCalculator: true,
  proactiveEngagement: false,
  multilingual: true,
  voiceAi: false,
  automatedFollowup: false,
  priceDropAlerts: false,
  crossStoreInventory: false,
  leadScoring: true,
  copilot: true,
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

    const merged: Record<string, boolean> = { ...PLATFORM_FEATURE_DEFAULTS };
    for (const [k, v] of Object.entries(tenantFlags)) {
      if (typeof v === 'boolean') merged[k] = v;
    }
    for (const [k, v] of Object.entries(locationFlags)) {
      if (typeof v === 'boolean') merged[k] = v;
    }

    // Hard gate: never expose live Tekion features without liveReady connection
    if (!tekionLive) {
      merged.tekionIntegration = false;
    }

    return merged;
  }

  /** Widget-safe subset */
  async forWidget(tenantId: string, locationId: string) {
    const f = await this.resolve(tenantId, locationId);
    return {
      chat: f.chat !== false,
      inventory: f.inventory !== false,
      payments: f.payments !== false && f.financeCalculator !== false,
      vehicleCompare: f.vehicleCompare !== false,
      savedVehicles: f.savedVehicles !== false,
      serviceAi: f.serviceAi !== false,
      partsAi: f.partsAi !== false,
      proactiveEngagement: f.proactiveEngagement === true,
      multilingual: f.multilingual !== false,
      voiceAi: false, // never claim voice until live
      leadCapture: true,
      handoff: true,
    };
  }
}
