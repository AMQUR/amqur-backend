import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

export const CANARY_COOKIE_NAME = 'amqur_canary_emp';

export type CanarySessionClaims = {
  typ: 'canary_emp';
  jti: string;
  tenantId: string;
  locationId: string;
  tenantSlug: string;
  locationSlug: string;
  env: string;
  tester?: string;
};

@Injectable()
export class CanaryAuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
  ) {}

  private secret(): string {
    const dedicated = this.config.get<string>('CANARY_EMPLOYEE_SECRET')?.trim();
    if (dedicated && dedicated.length >= 32) return dedicated;
    return this.config.getOrThrow<string>('JWT_SECRET');
  }

  private environment(): string {
    return this.config.get<string>('CANARY_ENVIRONMENT') ?? 'staging';
  }

  isMasterEnabled(): boolean {
    return this.config.get<string>('CANARY_EMPLOYEE_ENABLED') === 'true';
  }

  private parseOrigins(raw: string | null | undefined): string[] {
    return (raw ?? '')
      .split(',')
      .map((o) => o.trim().toLowerCase())
      .filter(Boolean);
  }

  assertOriginAllowed(
    allowedOrigins: string | null | undefined,
    requestOrigin?: string | null,
  ): string {
    const allowed = this.parseOrigins(allowedOrigins);
    if (allowed.length === 0) {
      throw new ForbiddenException(
        'Widget origins not configured for this tenant',
      );
    }
    const origin = (requestOrigin ?? '').trim().toLowerCase();
    if (!origin || !allowed.includes(origin)) {
      throw new ForbiddenException('Origin not allowed for this tenant');
    }
    return origin;
  }

  async issueInvite(input: {
    tenantSlug: string;
    locationSlug: string;
    testerLabel?: string;
    createdByUserId?: string;
    ttlSeconds?: number;
  }) {
    if (!this.isMasterEnabled()) {
      throw new ForbiddenException('Employee canary is disabled');
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { slug: input.tenantSlug },
    });
    if (!tenant) throw new UnauthorizedException('Invalid tenant');

    const location = await this.prisma.location.findFirst({
      where: { slug: input.locationSlug, tenantId: tenant.id },
    });
    if (!location) throw new UnauthorizedException('Invalid location');

    const ttl =
      input.ttlSeconds ??
      this.parseDurationSeconds(
        this.config.get<string>('CANARY_INVITE_EXPIRES_IN') ?? '15m',
        900,
      );
    const jti = randomUUID();
    const expiresAt = new Date(Date.now() + ttl * 1000);

    await this.prisma.canaryInvite.create({
      data: {
        jti,
        tenantId: tenant.id,
        locationId: location.id,
        environment: this.environment(),
        testerLabel: input.testerLabel?.slice(0, 120),
        expiresAt,
        createdByUserId: input.createdByUserId,
      },
    });

    await this.auditSafe({
      tenantId: tenant.id,
      userId: input.createdByUserId,
      action: 'canary.invite.issue',
      resource: 'CanaryInvite',
      resourceId: jti,
      metadata: {
        tenantSlug: tenant.slug,
        locationSlug: location.slug,
        environment: this.environment(),
        expiresAt: expiresAt.toISOString(),
        testerLabel: input.testerLabel?.slice(0, 120) ?? null,
        // Never store inviteToken or signing material.
      },
    });

    const inviteToken = this.jwt.sign(
      {
        typ: 'canary_invite',
        jti,
        tenantId: tenant.id,
        locationId: location.id,
        tenantSlug: tenant.slug,
        locationSlug: location.slug,
        env: this.environment(),
        tester: input.testerLabel?.slice(0, 120),
      },
      { secret: this.secret(), expiresIn: ttl },
    );

    return {
      inviteToken,
      expiresAt: expiresAt.toISOString(),
      jti,
      tenantSlug: tenant.slug,
      locationSlug: location.slug,
      environment: this.environment(),
      // Redeem on a controlled staging host — never embed token in Apollo.
      redeemHint:
        'POST /api/public/canary-redeem with inviteToken from an allowlisted Origin; sets HttpOnly cookie.',
    };
  }

  async redeemInvite(
    inviteToken: string,
    requestOrigin?: string | null,
  ): Promise<{ cookieValue: string; maxAgeSec: number; claims: CanarySessionClaims }> {
    if (!this.isMasterEnabled()) {
      throw new ForbiddenException('Employee canary is disabled');
    }

    let payload: Record<string, unknown>;
    try {
      payload = this.jwt.verify(inviteToken, { secret: this.secret() }) as Record<
        string,
        unknown
      >;
    } catch {
      throw new UnauthorizedException('Invalid or expired invite');
    }

    if (payload.typ !== 'canary_invite' || typeof payload.jti !== 'string') {
      throw new UnauthorizedException('Invalid invite type');
    }
    if (payload.env !== this.environment()) {
      throw new ForbiddenException('Invite environment mismatch');
    }

    const invite = await this.prisma.canaryInvite.findUnique({
      where: { jti: payload.jti },
    });
    if (!invite) throw new UnauthorizedException('Invite not found');
    if (invite.revokedAt) throw new ForbiddenException('Invite revoked');
    if (invite.redeemedAt) throw new ForbiddenException('Invite already used');
    if (invite.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Invite expired');
    }
    if (
      invite.tenantId !== payload.tenantId ||
      invite.locationId !== payload.locationId
    ) {
      throw new ForbiddenException('Invite claim mismatch');
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: invite.tenantId },
    });
    if (!tenant) throw new UnauthorizedException('Invalid tenant');
    this.assertOriginAllowed(tenant.allowedOrigins, requestOrigin);

    const location = await this.prisma.location.findFirst({
      where: { id: invite.locationId, tenantId: tenant.id },
    });
    if (!location) throw new UnauthorizedException('Invalid location');

    await this.prisma.canaryInvite.update({
      where: { id: invite.id },
      data: { redeemedAt: new Date() },
    });

    await this.auditSafe({
      tenantId: tenant.id,
      userId: invite.createdByUserId ?? undefined,
      action: 'canary.invite.redeem',
      resource: 'CanaryInvite',
      resourceId: invite.jti,
      metadata: {
        tenantSlug: tenant.slug,
        locationSlug: location.slug,
        environment: this.environment(),
        origin: (requestOrigin ?? '').trim().toLowerCase() || null,
        // Never store cookie value or invite token.
      },
    });

    const sessionTtl = this.parseDurationSeconds(
      this.config.get<string>('CANARY_SESSION_EXPIRES_IN') ?? '2h',
      7200,
    );
    const sessionJti = randomUUID();
    const claims: CanarySessionClaims = {
      typ: 'canary_emp',
      jti: sessionJti,
      tenantId: tenant.id,
      locationId: location.id,
      tenantSlug: tenant.slug,
      locationSlug: location.slug,
      env: this.environment(),
      tester:
        typeof payload.tester === 'string'
          ? payload.tester.slice(0, 120)
          : undefined,
    };

    const cookieValue = this.jwt.sign(claims, {
      secret: this.secret(),
      expiresIn: sessionTtl,
    });

    return { cookieValue, maxAgeSec: sessionTtl, claims };
  }

  async checkEligibility(input: {
    cookieHeader?: string | null;
    requestOrigin?: string | null;
    tenantSlug: string;
    locationSlug: string;
  }): Promise<{ eligible: boolean; reason?: string }> {
    if (!this.isMasterEnabled()) {
      return { eligible: false, reason: 'canary_disabled' };
    }

    const raw = this.readCookie(input.cookieHeader, CANARY_COOKIE_NAME);
    if (!raw) return { eligible: false, reason: 'missing_credential' };

    let claims: CanarySessionClaims;
    try {
      claims = this.jwt.verify(raw, { secret: this.secret() }) as CanarySessionClaims;
    } catch {
      return { eligible: false, reason: 'invalid_or_expired' };
    }

    if (claims.typ !== 'canary_emp') {
      return { eligible: false, reason: 'wrong_token_type' };
    }
    if (claims.env !== this.environment()) {
      return { eligible: false, reason: 'environment_mismatch' };
    }
    if (
      claims.tenantSlug !== input.tenantSlug ||
      claims.locationSlug !== input.locationSlug
    ) {
      return { eligible: false, reason: 'tenant_or_rooftop_mismatch' };
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { slug: input.tenantSlug },
    });
    if (!tenant || tenant.id !== claims.tenantId) {
      return { eligible: false, reason: 'tenant_mismatch' };
    }

    try {
      this.assertOriginAllowed(tenant.allowedOrigins, input.requestOrigin);
    } catch {
      return { eligible: false, reason: 'origin_rejected' };
    }

    const location = await this.prisma.location.findFirst({
      where: {
        slug: input.locationSlug,
        tenantId: tenant.id,
      },
    });
    if (!location || location.id !== claims.locationId) {
      return { eligible: false, reason: 'location_mismatch' };
    }

    // Revocation: if an invite jti was session-linked we only track invites;
    // session cookies are short-lived JWT. Optional future: session revoke table.
    return { eligible: true };
  }

  async revokeInvite(jti: string, actorUserId?: string) {
    const invite = await this.prisma.canaryInvite.findUnique({ where: { jti } });
    if (!invite) throw new UnauthorizedException('Invite not found');
    await this.prisma.canaryInvite.update({
      where: { id: invite.id },
      data: { revokedAt: new Date() },
    });
    await this.auditSafe({
      tenantId: invite.tenantId,
      userId: actorUserId,
      action: 'canary.invite.revoke',
      resource: 'CanaryInvite',
      resourceId: jti,
      metadata: { environment: invite.environment },
    });
    return { revoked: true, jti };
  }

  /** Persist audit without secrets; never throw away the primary operation. */
  private async auditSafe(data: {
    tenantId?: string;
    userId?: string;
    action: string;
    resource: string;
    resourceId: string;
    metadata?: Record<string, unknown>;
  }) {
    try {
      await this.prisma.auditLog.create({
        data: {
          tenantId: data.tenantId,
          userId: data.userId,
          action: data.action,
          resource: data.resource,
          resourceId: data.resourceId,
          metadata: data.metadata as never,
        },
      });
    } catch {
      // Audit failure must not block canary control plane.
    }
  }

  buildSetCookieHeader(value: string, maxAgeSec: number): string {
    // Cross-site jeepofchicago.com → staging API requires Secure + SameSite=None.
    return [
      `${CANARY_COOKIE_NAME}=${value}`,
      'Path=/',
      'HttpOnly',
      'SameSite=None',
      'Secure',
      `Max-Age=${maxAgeSec}`,
    ].join('; ');
  }

  readCookie(header: string | null | undefined, name: string): string | null {
    if (!header) return null;
    const parts = header.split(';');
    for (const part of parts) {
      const [k, ...rest] = part.trim().split('=');
      if (k === name) return rest.join('=') || null;
    }
    return null;
  }

  /** Test helper: forge check without DB */
  hashOpaque(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private parseDurationSeconds(raw: string, fallback: number): number {
    const m = /^(\d+)([smhd])$/i.exec(raw.trim());
    if (!m) return fallback;
    const n = Number(m[1]);
    const u = m[2].toLowerCase();
    if (u === 's') return n;
    if (u === 'm') return n * 60;
    if (u === 'h') return n * 3600;
    if (u === 'd') return n * 86400;
    return fallback;
  }
}
