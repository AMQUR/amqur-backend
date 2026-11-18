import { Injectable, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { CanaryAuthService } from './canary-auth.service';

export const WIDGET_TOKEN_DENIED = 'Widget not available for this origin';

@Injectable()
export class WidgetAuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
    private canaryAuth: CanaryAuthService,
  ) {}

  async createWidgetToken(
    tenantSlug: string,
    locationSlug: string,
    requestOrigin?: string | null,
    cookieHeader?: string | null,
  ) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { slug: tenantSlug },
    });

    // One indistinguishable refusal for: unknown tenant, no allowlist, origin
    // not on the allowlist, missing Origin, unknown location. Different
    // statuses or messages would let anyone enumerate tenant slugs and learn
    // which tenants are live.
    const denied = () => new ForbiddenException(WIDGET_TOKEN_DENIED);

    if (!tenant) throw denied();

    // Fail closed: empty allowlist must never mint tokens for arbitrary origins.
    const allowed = (tenant.allowedOrigins ?? '')
      .split(',')
      .map((o) => o.trim().toLowerCase())
      .filter(Boolean);
    const origin = (requestOrigin ?? '').trim().toLowerCase();
    if (allowed.length === 0 || !origin || !allowed.includes(origin)) {
      throw denied();
    }

    const location = await this.prisma.location.findFirst({
      where: {
        slug: locationSlug,
        tenantId: tenant.id,
      },
    });

    if (!location) throw denied();

    await this.assertCanarySessionIfStrict(
      origin,
      cookieHeader,
      tenantSlug,
      locationSlug,
    );

    const expiresIn =
      this.config.get<string>('WIDGET_TOKEN_EXPIRES_IN') ?? '4h';

    // Widget tokens use a dedicated secret when configured so they can be
    // rotated independently of staff/admin JWTs (falls back to JWT_SECRET).
    const widgetSecret = this.config.get<string>('WIDGET_TOKEN_SECRET')?.trim();

    const token = this.jwt.sign(
      {
        sub: 'widget',
        role: 'widget',
        tenantId: tenant.id,
        locationId: location.id,
        typ: 'widget',
        // Bound to the page origin it was issued for; JwtAuthGuard refuses the
        // token when a browser presents it from any other origin.
        origin,
      },
      {
        ...(widgetSecret ? { secret: widgetSecret } : {}),
        expiresIn: expiresIn as
          | `${number}m`
          | `${number}d`
          | `${number}h`
          | `${number}s`,
      },
    );

    return { token, expiresIn };
  }

  /**
   * Jeep (and other) production hostnames on the canary allowlist must not
   * mint widget tokens for ordinary public browsers — require signed canary session.
   */
  private async assertCanarySessionIfStrict(
    origin: string,
    cookieHeader: string | null | undefined,
    tenantSlug: string,
    locationSlug: string,
  ): Promise<void> {
    if (!this.canaryAuth.isMasterEnabled()) return;

    const strict = (this.config.get<string>('CANARY_STRICT_ORIGINS') ?? '')
      .split(',')
      .map((o) => o.trim().toLowerCase())
      .filter(Boolean);
    if (strict.length === 0 || !strict.includes(origin)) return;

    const elig = await this.canaryAuth.checkEligibility({
      cookieHeader,
      requestOrigin: origin,
      tenantSlug,
      locationSlug,
    });
    if (!elig.eligible) {
      throw new ForbiddenException(
        `Employee canary required (${elig.reason ?? 'denied'})`,
      );
    }
  }
}
