import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class WidgetAuthService {
    constructor(
        private prisma: PrismaService,
        private jwt: JwtService,
    ) { }

    async createWidgetToken(tenantSlug: string, locationSlug: string) {
        const tenant = await this.prisma.tenant.findUnique({
            where: { slug: tenantSlug },
        });

        if (!tenant) {
            throw new UnauthorizedException('Invalid tenant');
        }

        const location = await this.prisma.location.findFirst({
            where: {
                slug: locationSlug,
                tenantId: tenant.id,
            },
        });

        if (!location) {
            throw new UnauthorizedException('Invalid location');
        }

        // Widget tokens are short-lived (4 h). The widget refreshes automatically on 401.
        const token = this.jwt.sign(
            {
                sub: 'widget',
                role: 'widget',
                tenantId: tenant.id,
                locationId: location.id,
            },
            { expiresIn: '4h' },
        );

        return { token };
    }
}
