import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';

describe('AuthService disabled-user enforcement', () => {
  const passwordHash = bcrypt.hashSync('correct-password', 4);

  function makeService(overrides: {
    user?: Record<string, unknown> | null;
    users?: Record<string, unknown>[];
    storedRefresh?: Record<string, unknown> | null;
  }) {
    const prisma = {
      user: {
        findFirst: jest.fn().mockResolvedValue(overrides.user ?? null),
        findMany: jest.fn().mockResolvedValue(overrides.users ?? []),
        count: jest.fn().mockResolvedValue(0),
      },
      refreshToken: {
        findUnique: jest
          .fn()
          .mockResolvedValue(overrides.storedRefresh ?? null),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({}),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const jwt = { sign: jest.fn().mockReturnValue('tok') };
    const config = {
      get: jest.fn((k: string) => {
        if (k === 'JWT_EXPIRES_IN') return '15m';
        if (k === 'JWT_REFRESH_EXPIRES_IN') return '7d';
        return undefined;
      }),
      getOrThrow: jest.fn().mockReturnValue('15m'),
    };
    return new AuthService(prisma as never, jwt as never, config as never);
  }

  const activeUser = {
    id: 'u1',
    email: 'staff@example.com',
    password: passwordHash,
    role: 'ADMIN',
    tenantId: 't1',
    isActive: true,
  };

  it('active user with valid password logs in', async () => {
    const svc = makeService({ user: activeUser });
    await expect(
      svc.login({
        email: 'staff@example.com',
        password: 'correct-password',
        tenantSlug: 'tenant-a',
      } as never),
    ).resolves.toBeDefined();
  });

  it('disabled user cannot log in (tenantSlug path)', async () => {
    const svc = makeService({ user: { ...activeUser, isActive: false } });
    await expect(
      svc.login({
        email: 'staff@example.com',
        password: 'correct-password',
        tenantSlug: 'tenant-a',
      } as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('disabled user cannot log in (email-only path)', async () => {
    const svc = makeService({ users: [{ ...activeUser, isActive: false }] });
    await expect(
      svc.login({
        email: 'staff@example.com',
        password: 'correct-password',
      } as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('disabled user cannot refresh even with a live refresh token', async () => {
    const svc = makeService({
      storedRefresh: {
        id: 'rt1',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        user: { ...activeUser, isActive: false },
      },
    });
    await expect(svc.refresh('raw-refresh-token')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
