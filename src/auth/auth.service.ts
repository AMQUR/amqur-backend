import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { Prisma, Role } from '@prisma/client';
import { SecretVaultService } from '../integrations/core/secret-vault.service';
import { generateSecret, otpauthUri, verifyTotp } from './totp';

/** Roles that must complete MFA before using staff APIs (env STAFF_MFA_REQUIRED_ROLES). */
export function mfaRequiredRoles(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const raw = env.STAFF_MFA_REQUIRED_ROLES;
  if (raw !== undefined)
    return raw
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
  return env.NODE_ENV === 'production' ? ['SUPER_ADMIN', 'ADMIN'] : [];
}

type SafeUser = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
  tenantId: string;
  locationId: string | null;
  createdAt?: Date;
  updatedAt?: Date;
};

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
    private vault: SecretVaultService,
  ) {}

  private sanitizeUser(user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    role: Role;
    tenantId: string;
    locationId: string | null;
    createdAt?: Date;
    updatedAt?: Date;
    password?: string;
  }): SafeUser {
    const { password: _password, ...safeUser } = user;
    return safeUser;
  }

  private buildAccessToken(
    user: {
      id: string;
      tenantId: string;
      locationId: string | null;
      role: Role;
    },
    amr: string[] = ['pwd'],
  ) {
    const expiresIn = this.config.get<string>('JWT_EXPIRES_IN') ?? '15m';
    return this.jwt.sign(
      {
        sub: user.id,
        tenantId: user.tenantId,
        locationId: user.locationId,
        role: user.role,
        typ: 'access',
        amr,
      },
      {
        // Nest JWT typings expect ms.StringValue; env strings like "15m" are valid at runtime
        expiresIn: expiresIn as
          | `${number}m`
          | `${number}d`
          | `${number}h`
          | `${number}s`,
      },
    );
  }

  private hashToken(raw: string): string {
    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  private async issueRefreshToken(userId: string): Promise<string> {
    const raw = crypto.randomBytes(48).toString('hex');
    const tokenHash = this.hashToken(raw);
    const expiresIn = this.config.get<string>('JWT_REFRESH_EXPIRES_IN') ?? '7d';
    const days = expiresIn.endsWith('d') ? parseInt(expiresIn, 10) || 7 : 7;
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    await this.prisma.refreshToken.create({
      data: { userId, tokenHash, expiresAt },
    });

    return raw;
  }

  private async tokensFor(
    user: {
      id: string;
      email: string;
      firstName: string;
      lastName: string;
      role: Role;
      tenantId: string;
      locationId: string | null;
      mfaEnabled?: boolean;
    },
    amr: string[] = ['pwd'],
  ) {
    const access_token = this.buildAccessToken(user, amr);
    const refresh_token = await this.issueRefreshToken(user.id);
    return {
      access_token,
      refresh_token,
      token_type: 'Bearer',
      expires_in: this.config.get<string>('JWT_EXPIRES_IN') ?? '15m',
      user: this.sanitizeUser(user),
      mfa_enrollment_required:
        !user.mfaEnabled && mfaRequiredRoles().includes(user.role),
    };
  }

  /**
   * Staff-only registration. Caller must already be SUPER_ADMIN or ADMIN
   * for the target tenant (enforced by controller + RolesGuard).
   */
  async register(dto: RegisterDto, actor: { role: string; tenantId: string }) {
    if (actor.role !== 'SUPER_ADMIN' && actor.tenantId !== dto.tenantId) {
      throw new ForbiddenException('Cannot register users for another tenant');
    }

    const email = dto.email.toLowerCase();
    const existing = await this.prisma.user.findUnique({
      where: {
        tenantId_email: { tenantId: dto.tenantId, email },
      },
    });

    if (existing) {
      throw new UnauthorizedException('User already exists');
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: dto.tenantId },
    });
    if (!tenant) {
      throw new UnauthorizedException('Tenant not found');
    }

    if (dto.locationId) {
      const location = await this.prisma.location.findFirst({
        where: { id: dto.locationId, tenantId: dto.tenantId },
      });
      if (!location) {
        throw new UnauthorizedException('Location not found for tenant');
      }
    }

    const role =
      actor.role === 'SUPER_ADMIN'
        ? ((dto.role as Role | undefined) ?? Role.STAFF)
        : Role.STAFF;

    // Non-super-admins cannot create SUPER_ADMIN
    if (actor.role !== 'SUPER_ADMIN' && role === Role.SUPER_ADMIN) {
      throw new ForbiddenException('Cannot assign SUPER_ADMIN');
    }

    const hashedPassword = await bcrypt.hash(dto.password, 12);

    const user = await this.prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        firstName: dto.firstName,
        lastName: dto.lastName,
        tenantId: dto.tenantId,
        role,
        ...(dto.locationId && { locationId: dto.locationId }),
      },
    });

    await this.prisma.auditLog.create({
      data: {
        tenantId: dto.tenantId,
        userId: actor.role === 'SUPER_ADMIN' ? undefined : undefined,
        action: 'user.register',
        resource: 'User',
        resourceId: user.id,
        metadata: { email, role },
      },
    });

    return { user: this.sanitizeUser(user) };
  }

  /**
   * One-time ops bootstrap: create platform SUPER_ADMIN (+ optional seed tenant).
   * Protected by BOOTSTRAP_SECRET in the request body (not JWT).
   * Becomes unavailable after any SUPER_ADMIN exists, or when BOOTSTRAP_SECRET is unset.
   */
  async bootstrap(input: {
    secret: string;
    tenantName: string;
    tenantSlug: string;
    email: string;
    password: string;
    firstName: string;
    lastName: string;
  }) {
    const expected = this.config.get<string>('BOOTSTRAP_SECRET');
    if (!expected || expected.length < 16) {
      throw new ForbiddenException('Bootstrap is disabled');
    }

    const existingSuperAdmin = await this.prisma.user.count({
      where: { role: Role.SUPER_ADMIN },
    });
    if (existingSuperAdmin > 0) {
      throw new ForbiddenException(
        'Bootstrap is unavailable after platform initialization',
      );
    }

    if (input.secret !== expected) {
      throw new ForbiddenException('Invalid bootstrap secret');
    }

    const existingTenant = await this.prisma.tenant.findUnique({
      where: { slug: input.tenantSlug },
    });
    if (existingTenant) {
      throw new UnauthorizedException('Tenant slug already exists');
    }

    const hashedPassword = await bcrypt.hash(input.password, 12);

    const result = await this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: { name: input.tenantName, slug: input.tenantSlug },
      });
      const user = await tx.user.create({
        data: {
          email: input.email.toLowerCase(),
          password: hashedPassword,
          firstName: input.firstName,
          lastName: input.lastName,
          tenantId: tenant.id,
          role: Role.SUPER_ADMIN,
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId: tenant.id,
          userId: user.id,
          action: 'auth.bootstrap',
          resource: 'Tenant',
          resourceId: tenant.id,
        },
      });
      return { tenant, user };
    });

    return this.tokensFor(result.user);
  }

  async login(dto: LoginDto) {
    const email = dto.email.toLowerCase();

    if (dto.tenantSlug) {
      const user = await this.prisma.user.findFirst({
        where: {
          email,
          tenant: { slug: dto.tenantSlug },
        },
      });
      if (!user || !user.isActive) {
        throw new UnauthorizedException('Invalid credentials');
      }
      const passwordValid = await bcrypt.compare(dto.password, user.password);
      if (!passwordValid) {
        throw new UnauthorizedException('Invalid credentials');
      }
      return this.completePasswordLogin(user);
    }

    const matches = await this.prisma.user.findMany({
      where: { email },
      take: 5,
    });

    if (matches.length === 0) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (matches.length > 1) {
      throw new UnauthorizedException(
        'Multiple accounts found for this email — provide tenantSlug',
      );
    }

    const user = matches[0];
    if (!user.isActive) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const passwordValid = await bcrypt.compare(dto.password, user.password);
    if (!passwordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return this.completePasswordLogin(user);
  }

  /** Password verified. MFA-enrolled users get a short-lived challenge instead of tokens. */
  private async completePasswordLogin(user: Prisma.UserGetPayload<object>) {
    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        action: user.mfaEnabled
          ? 'auth.login.password_ok_mfa_pending'
          : 'auth.login',
        resource: 'User',
        resourceId: user.id,
      },
    });
    if (user.mfaEnabled) {
      const mfa_token = this.jwt.sign(
        { sub: user.id, typ: 'mfa_challenge' },
        { expiresIn: '5m' },
      );
      return { mfa_required: true, mfa_token };
    }
    return this.tokensFor(user, ['pwd']);
  }

  private hashRecovery(code: string): string {
    return crypto
      .createHash('sha256')
      .update(`amqur-recovery:${code.replace(/[\s-]/g, '').toLowerCase()}`)
      .digest('hex');
  }

  async verifyMfa(mfaToken: string, code: string) {
    let payload: { sub?: string; typ?: string };
    try {
      payload = await this.jwt.verifyAsync(mfaToken);
    } catch {
      throw new UnauthorizedException('MFA challenge expired — sign in again');
    }
    if (payload.typ !== 'mfa_challenge' || !payload.sub)
      throw new UnauthorizedException('Invalid MFA challenge');
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });
    if (!user || !user.isActive || !user.mfaEnabled || !user.mfaSecretEnc)
      throw new UnauthorizedException('Invalid MFA challenge');
    const secret = this.vault.decrypt(
      user.mfaSecretEnc as { ciphertext: string; iv: string; authTag: string },
    );
    const counter = verifyTotp(secret, code.trim());
    if (counter !== null) {
      // Replay protection: a code (time step) can be used once.
      const res = await this.prisma.user.updateMany({
        where: {
          id: user.id,
          OR: [{ mfaLastCounter: null }, { mfaLastCounter: { lt: counter } }],
        },
        data: { mfaLastCounter: counter },
      });
      if (res.count === 0)
        throw new UnauthorizedException(
          'Code already used — wait for the next one',
        );
    } else {
      const h = this.hashRecovery(code);
      if (!user.mfaRecoveryHashes.includes(h)) {
        await this.prisma.auditLog.create({
          data: {
            tenantId: user.tenantId,
            userId: user.id,
            action: 'auth.mfa.failed',
            resource: 'User',
            resourceId: user.id,
          },
        });
        throw new UnauthorizedException('Invalid code');
      }
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          mfaRecoveryHashes: user.mfaRecoveryHashes.filter((x) => x !== h),
        },
      });
      await this.prisma.auditLog.create({
        data: {
          tenantId: user.tenantId,
          userId: user.id,
          action: 'auth.mfa.recovery_code_used',
          resource: 'User',
          resourceId: user.id,
        },
      });
    }
    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        action: 'auth.login',
        resource: 'User',
        resourceId: user.id,
        metadata: { amr: ['pwd', 'otp'] },
      },
    });
    return this.tokensFor(user, ['pwd', 'otp']);
  }

  async setupMfa(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    if (!this.vault.isReady())
      throw new ForbiddenException(
        'MFA unavailable: INTEGRATION_ENCRYPTION_KEY not configured',
      );
    const secret = generateSecret();
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        mfaPendingSecretEnc: this.vault.encrypt(
          secret,
        ) as unknown as Prisma.InputJsonValue,
      },
    });
    const issuer =
      this.config.get<string>('MFA_ISSUER') ?? 'AMQUR Command Center';
    return {
      secret,
      otpauthUri: otpauthUri({ secret, account: user.email, issuer }),
    };
  }

  async confirmMfa(userId: string, code: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    if (!user.mfaPendingSecretEnc)
      throw new ForbiddenException('Start MFA setup first');
    const secret = this.vault.decrypt(
      user.mfaPendingSecretEnc as {
        ciphertext: string;
        iv: string;
        authTag: string;
      },
    );
    const counter = verifyTotp(secret, code.trim());
    if (counter === null) throw new UnauthorizedException('Invalid code');
    const recovery = Array.from({ length: 8 }, () =>
      crypto
        .randomBytes(5)
        .toString('hex')
        .replace(/(.{5})/, '$1-'),
    );
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        mfaEnabled: true,
        mfaSecretEnc: user.mfaPendingSecretEnc as Prisma.InputJsonValue,
        mfaPendingSecretEnc: Prisma.DbNull,
        mfaLastCounter: counter,
        mfaEnrolledAt: new Date(),
        mfaRecoveryHashes: recovery.map((r) => this.hashRecovery(r)),
      },
    });
    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        userId,
        action: 'auth.mfa.enrolled',
        resource: 'User',
        resourceId: userId,
      },
    });
    // Recovery codes are shown ONCE; only hashes are stored.
    return {
      enabled: true,
      recoveryCodes: recovery,
      ...(await this.tokensFor({ ...user, mfaEnabled: true }, ['pwd', 'otp'])),
    };
  }

  /** Revoke every refresh token (all devices). Access tokens expire within JWT_EXPIRES_IN (≤15m). */
  async logoutAll(userId: string) {
    const res = await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { tenantId: true },
    });
    await this.prisma.auditLog.create({
      data: {
        tenantId: user?.tenantId ?? null,
        userId,
        action: 'auth.logout_all',
        resource: 'User',
        resourceId: userId,
        metadata: { revoked: res.count },
      },
    });
    return { ok: true, revokedSessions: res.count };
  }

  /** Admin reset of another user's MFA (lost device) — audited; user must re-enroll. */
  async resetMfa(
    actor: { sub: string; tenantId: string; role: string },
    targetUserId: string,
  ) {
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
    });
    if (
      !target ||
      (actor.role !== 'SUPER_ADMIN' && target.tenantId !== actor.tenantId)
    )
      throw new ForbiddenException('User not found');
    if (target.role === 'SUPER_ADMIN' && actor.role !== 'SUPER_ADMIN')
      throw new ForbiddenException('Cannot reset a super admin');
    await this.prisma.user.update({
      where: { id: targetUserId },
      data: {
        mfaEnabled: false,
        mfaSecretEnc: Prisma.DbNull,
        mfaPendingSecretEnc: Prisma.DbNull,
        mfaRecoveryHashes: [],
        mfaLastCounter: null,
      },
    });
    await this.prisma.refreshToken.updateMany({
      where: { userId: targetUserId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.prisma.auditLog.create({
      data: {
        tenantId: target.tenantId,
        userId: actor.sub,
        action: 'auth.mfa.reset',
        resource: 'User',
        resourceId: targetUserId,
      },
    });
    return { ok: true };
  }

  async refresh(rawRefreshToken: string) {
    const tokenHash = this.hashToken(rawRefreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (!stored.user.isActive) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Rotate: revoke old, issue new pair
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    // Refresh tokens for MFA-enrolled users are only ever issued after an OTP step.
    return this.tokensFor(
      stored.user,
      stored.user.mfaEnabled ? ['pwd', 'otp'] : ['pwd'],
    );
  }

  async logout(rawRefreshToken: string) {
    const tokenHash = this.hashToken(rawRefreshToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { ok: true };
  }
}
