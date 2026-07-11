import { RolesGuard } from './roles.guard';
import { Reflector } from '@nestjs/core';
import { ForbiddenException } from '@nestjs/common';

function mockContext(user: unknown) {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  } as any;
}

describe('RolesGuard', () => {
  it('allows when no roles metadata', () => {
    const reflector = {
      getAllAndOverride: () => undefined,
    } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(mockContext({ role: 'widget' }))).toBe(true);
  });

  it('rejects widget role for staff-only routes', () => {
    const reflector = {
      getAllAndOverride: () => ['ADMIN', 'SUPER_ADMIN'],
    } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    expect(() =>
      guard.canActivate(mockContext({ role: 'widget' })),
    ).toThrow(ForbiddenException);
  });

  it('allows matching role', () => {
    const reflector = {
      getAllAndOverride: () => ['ADMIN'],
    } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(mockContext({ role: 'ADMIN' }))).toBe(true);
  });
});
