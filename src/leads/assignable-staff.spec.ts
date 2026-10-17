import { assignableStaffWhere } from './round-robin';

describe('assignableStaffWhere', () => {
  it('scopes to tenant-wide assignable roles', () => {
    expect(assignableStaffWhere('tenant-1')).toEqual({
      tenantId: 'tenant-1',
      isActive: true,
      role: { in: ['STAFF', 'MANAGER'] },
    });
  });

  it('includes tenant-wide staff when lead has a rooftop', () => {
    expect(assignableStaffWhere('tenant-1', 'loc-1')).toEqual({
      tenantId: 'tenant-1',
      isActive: true,
      role: { in: ['STAFF', 'MANAGER'] },
      OR: [{ locationId: 'loc-1' }, { locationId: null }],
    });
  });
});
