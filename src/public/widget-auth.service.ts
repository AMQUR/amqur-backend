import { Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class WidgetAuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
  ) {}

  async createWidgetToken(
    tenantSlug: string,
    locationSlug: string,
    requestOrigin?: string | null,
  ) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { slug: tenantSlug },
    });

    if (!tenant) {
      throw new UnauthorizedException('Invalid tenant');
    }

    // Fail closed: empty allowlist must never mint tokens for arbitrary origins.
    const allowedRaw = tenant.allowedOrigins?.trim();
    if (!allowedRaw) {
      throw new ForbiddenException(
        'Widget origins not configured for this tenant',
      );
    }
    const allowed = allowedRaw
      .split(',')
      .map((o) => o.trim().toLowerCase())
      .filter(Boolean);
    if (allowed.length === 0) {
      throw new ForbiddenException(
        'Widget origins not configured for this tenant',
      );
    }
    const origin = (requestOrigin ?? '').trim().toLowerCase();
    if (!origin || !allowed.includes(origin)) {
      throw new ForbiddenException('Origin not allowed for this tenant');
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

    const expiresIn =
      this.config.get<string>('WIDGET_TOKEN_EXPIRES_IN') ?? '4h';

    const token = this.jwt.sign(
      {
        sub: 'widget',
        role: 'widget',
        tenantId: tenant.id,
        locationId: location.id,
        typ: 'widget',
      },
      {
        expiresIn: expiresIn as
          | `${number}m`
          | `${number}d`
          | `${number}h`
          | `${number}s`,
      },
    );

    return { token, expiresIn };
  }
}
