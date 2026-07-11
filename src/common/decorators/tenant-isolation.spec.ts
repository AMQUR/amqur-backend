import { ForbiddenException } from '@nestjs/common';
import { resolveTenantId } from './current-user.decorator';
import type { AuthUser } from './current-user.decorator';

describe('tenant isolation (resolveTenantId)', () => {
  const adminA: AuthUser = {
    sub: 'user-a',
    tenantId: 'tenant-a',
    role: 'ADMIN',
  };
  const staffB: AuthUser = {
    sub: 'user-b',
    tenantId: 'tenant-b',
    role: 'STAFF',
  };
  const superAdmin: AuthUser = {
    sub: 'super',
    tenantId: 'tenant-a',
    role: 'SUPER_ADMIN',
  };

  it('locks staff to their JWT tenant', () => {
    expect(resolveTenantId(adminA)).toBe('tenant-a');
    expect(resolveTenantId(staffB)).toBe('tenant-b');
  });

  it('denies cross-tenant query override for ADMIN', () => {
    expect(() => resolveTenantId(adminA, 'tenant-b')).toThrow(
      ForbiddenException,
    );
  });

  it('denies cross-tenant query override for STAFF', () => {
    expect(() => resolveTenantId(staffB, 'tenant-a')).toThrow(
      ForbiddenException,
    );
  });

  it('allows SUPER_ADMIN to select another tenant explicitly', () => {
    expect(resolveTenantId(superAdmin, 'tenant-b')).toBe('tenant-b');
  });

  it('defaults SUPER_ADMIN to JWT tenant when no override', () => {
    expect(resolveTenantId(superAdmin)).toBe('tenant-a');
  });
});
