import { resolveTenantId } from './current-user.decorator';
import { ForbiddenException } from '@nestjs/common';

describe('resolveTenantId', () => {
  it('locks non-super-admins to JWT tenant', () => {
    expect(
      resolveTenantId(
        { sub: 'u1', tenantId: 'tenant-a', role: 'ADMIN' },
        undefined,
      ),
    ).toBe('tenant-a');
  });

  it('rejects cross-tenant requests for non-super-admins', () => {
    expect(() =>
      resolveTenantId(
        { sub: 'u1', tenantId: 'tenant-a', role: 'ADMIN' },
        'tenant-b',
      ),
    ).toThrow(ForbiddenException);
  });

  it('allows SUPER_ADMIN to select another tenant', () => {
    expect(
      resolveTenantId(
        { sub: 'u1', tenantId: 'tenant-a', role: 'SUPER_ADMIN' },
        'tenant-b',
      ),
    ).toBe('tenant-b');
  });
});
