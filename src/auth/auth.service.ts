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
import { Role } from '@prisma/client';

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

  private buildAccessToken(user: {
    id: string;
    tenantId: string;
    locationId: string | null;
    role: Role;
  }) {
    const expiresIn = this.config.get<string>('JWT_EXPIRES_IN') ?? '15m';
    return this.jwt.sign(
      {
        sub: user.id,
        tenantId: user.tenantId,
        locationId: user.locationId,
        role: user.role,
        typ: 'access',
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

  private async tokensFor(user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    role: Role;
    tenantId: string;
    locationId: string | null;
  }) {
    const access_token = this.buildAccessToken(user);
    const refresh_token = await this.issueRefreshToken(user.id);
    return {
      access_token,
      refresh_token,
      token_type: 'Bearer',
      expires_in: this.config.get<string>('JWT_EXPIRES_IN') ?? '15m',
      user: this.sanitizeUser(user),
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
   * One-time / ops bootstrap: create tenant + first SUPER_ADMIN.
   * Protected by BOOTSTRAP_SECRET header, not JWT.
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
      if (!user) {
        throw new UnauthorizedException('Invalid credentials');
      }
      const passwordValid = await bcrypt.compare(dto.password, user.password);
      if (!passwordValid) {
        throw new UnauthorizedException('Invalid credentials');
      }
      await this.prisma.auditLog.create({
        data: {
          tenantId: user.tenantId,
          userId: user.id,
          action: 'auth.login',
          resource: 'User',
          resourceId: user.id,
        },
      });
      return this.tokensFor(user);
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
    const passwordValid = await bcrypt.compare(dto.password, user.password);
    if (!passwordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        action: 'auth.login',
        resource: 'User',
        resourceId: user.id,
      },
    });

    return this.tokensFor(user);
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

    // Rotate: revoke old, issue new pair
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    return this.tokensFor(stored.user);
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
