import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { ConfigCacheService } from '../cache/config-cache.service';
import { mergePublicBranding } from '../common/types/public-branding';

@Injectable()
export class PublicService {
  constructor(
    private prisma: PrismaService,
    private readonly flags: FeatureFlagsService,
    private readonly cache: ConfigCacheService,
  ) {}

  async getWidgetConfig(tenantSlug: string, locationSlug?: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { slug: tenantSlug },
      select: {
        id: true,
        name: true,
        slug: true,
        publicConfig: true,
        configVersion: true,
        consentText: true,
        locations: {
          select: {
            id: true,
            name: true,
            slug: true,
            phone: true,
            timezone: true,
            publicConfig: true,
            // storeHours intentionally omitted from public payload unless present in publicConfig
          },
        },
      },
    });

    if (!tenant) {
      throw new NotFoundException('TENANT_NOT_FOUND');
    }

    const location = locationSlug
      ? tenant.locations.find((l) => l.slug === locationSlug)
      : tenant.locations[0];

    if (!location) {
      throw new NotFoundException('LOCATION_NOT_FOUND');
    }

    const cacheKey = this.cache.widgetConfigKey(
      tenant.slug,
      location.slug,
      tenant.configVersion,
    );
    const cached = await this.cache.getJson<Record<string, unknown>>(cacheKey);
    if (cached) return cached;

    const features = await this.flags.forWidget(tenant.id, location.id);
    const branding = mergePublicBranding(
      tenant.publicConfig,
      location.publicConfig,
      location.phone,
    );

    // Never expose internal ids beyond tenant/location public ids needed by widget session.
    // Never expose allowedOrigins, escalation recipients, feed URLs, or secrets.
    const payload = {
      ok: true,
      configVersion: tenant.configVersion,
      tenant: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
      },
      location: {
        id: location.id,
        name: location.name,
        slug: location.slug,
        timezone: location.timezone,
      },
      branding: {
        assistantDisplayName: branding.assistantDisplayName,
        welcomeMessage: branding.welcomeMessage,
        primaryColor: branding.primaryColor,
        accentColor: branding.accentColor,
        logoUrl: branding.logoUrl,
        launcherIconUrl: branding.launcherIconUrl,
        phone: branding.phone,
        websiteUrl: branding.websiteUrl,
        privacyUrl: branding.privacyUrl,
        termsUrl: branding.termsUrl,
        escalationMessage: branding.escalationMessage,
        disclaimerText: branding.disclaimerText,
        salesEnabled: branding.salesEnabled,
        serviceEnabled: branding.serviceEnabled,
        partsEnabled: branding.partsEnabled,
      },
      features,
      proactive: features.proactiveEngagement
        ? {
            enabled: true,
            maxPerSession: 2,
            signals: ['vdp_view', 'exit_intent', 'service_page'],
          }
        : { enabled: false },
      locales:
        branding.supportedLocales.length > 0
          ? branding.supportedLocales
          : features.multilingual
            ? ['en', 'es']
            : ['en'],
      consentText: tenant.consentText ?? null,
    };

    await this.cache.setJson(cacheKey, payload, 60);
    return payload;
  }

  /** Call after any branding/publicConfig/featureFlags change. */
  async bumpConfigVersion(tenantId: string): Promise<number> {
    const updated = await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { configVersion: { increment: 1 } },
      select: { configVersion: true, slug: true },
    });
    await this.invalidateWidgetConfigCache();
    return updated.configVersion;
  }

  async invalidateWidgetConfigCache(): Promise<void> {
    await this.cache.invalidatePrefix('widget-config:');
  }
}
