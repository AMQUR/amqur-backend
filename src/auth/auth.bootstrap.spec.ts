import { ForbiddenException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { Role } from '@prisma/client';

describe('AuthService.bootstrap lockout', () => {
  const config = {
    get: (key: string) => {
      if (key === 'BOOTSTRAP_SECRET') return 'test-bootstrap-secret-32chars!!';
      if (key === 'JWT_SECRET') return 'jwt-test-secret-at-least-32-chars!!';
      if (key === 'JWT_EXPIRES_IN') return '15m';
      if (key === 'JWT_REFRESH_EXPIRES_IN') return '7d';
      return undefined;
    },
  };

  function makeService(superAdminCount: number) {
    const prisma = {
      user: {
        count: jest.fn().mockResolvedValue(superAdminCount),
        create: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
      },
      tenant: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      auditLog: { create: jest.fn() },
      refreshToken: { create: jest.fn() },
      $transaction: jest.fn(),
    };
    const jwt = { sign: jest.fn().mockReturnValue('token') };
    return {
      svc: new AuthService(prisma as never, jwt as never, config as never),
      prisma,
    };
  }

  it('rejects when BOOTSTRAP_SECRET is short/missing', async () => {
    const badConfig = { get: () => undefined };
    const prisma = {
      user: { count: jest.fn() },
      tenant: { findUnique: jest.fn() },
    };
    const svc = new AuthService(
      prisma as never,
      { sign: jest.fn() } as never,
      badConfig as never,
    );
    await expect(
      svc.bootstrap({
        secret: 'x',
        tenantName: 'T',
        tenantSlug: 't',
        email: 'a@b.com',
        password: 'password1',
        firstName: 'A',
        lastName: 'B',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects wrong secret', async () => {
    const { svc } = makeService(0);
    await expect(
      svc.bootstrap({
        secret: 'wrong-secret-value-here!!!!',
        tenantName: 'T',
        tenantSlug: 't',
        email: 'a@b.com',
        password: 'password1',
        firstName: 'A',
        lastName: 'B',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('becomes unavailable after any SUPER_ADMIN exists', async () => {
    const { svc, prisma } = makeService(1);
    await expect(
      svc.bootstrap({
        secret: 'test-bootstrap-secret-32chars!!',
        tenantName: 'T',
        tenantSlug: 't',
        email: 'a@b.com',
        password: 'password1',
        firstName: 'A',
        lastName: 'B',
      }),
    ).rejects.toThrow(/unavailable after platform initialization/i);
    expect(prisma.user.count).toHaveBeenCalledWith({
      where: { role: Role.SUPER_ADMIN },
    });
  });
});
