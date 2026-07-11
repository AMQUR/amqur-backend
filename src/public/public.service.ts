import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';

@Injectable()
export class PublicService {
    constructor(
        private prisma: PrismaService,
        private readonly flags: FeatureFlagsService,
    ) { }

    async getWidgetConfig(
        tenantSlug: string,
        locationSlug?: string,
    ) {
        const tenant = await this.prisma.tenant.findUnique({
            where: { slug: tenantSlug },
            include: {
                locations: true,
            },
        });

        if (!tenant) {
            throw new NotFoundException('TENANT_NOT_FOUND');
        }

        const location = locationSlug
            ? tenant.locations.find(
                (l) => l.slug === locationSlug,
            )
            : tenant.locations[0];

        if (!location) {
            throw new NotFoundException('LOCATION_NOT_FOUND');
        }

        const features = await this.flags.forWidget(tenant.id, location.id);

        return {
            ok: true,

            tenant: {
                id: tenant.id,
                name: tenant.name,
                slug: tenant.slug,
            },

            location: {
                id: location.id,
                name: location.name,
                slug: location.slug,
            },

            branding: {
                primaryColor: '#000000',
                accentColor: '#ffffff',
                logoUrl: null,
            },

            features,
            proactive: features.proactiveEngagement
                ? {
                    enabled: true,
                    maxPerSession: 2,
                    signals: ['vdp_view', 'exit_intent', 'service_page'],
                  }
                : { enabled: false },
            locales: features.multilingual ? ['en', 'es'] : ['en'],
        };
    }
}
