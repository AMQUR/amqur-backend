import { pickRoundRobinAssignee, resolveNewLeadAssignee } from './round-robin';

describe('round-robin assignment', () => {
  it('returns null when no staff exist', async () => {
    const prisma = {
      user: { findMany: jest.fn().mockResolvedValue([]) },
      lead: { groupBy: jest.fn() },
    } as never;
    await expect(
      pickRoundRobinAssignee(prisma, 't1', 'loc1'),
    ).resolves.toBeNull();
  });

  it('picks the staffer with the fewest open leads', async () => {
    const prisma = {
      user: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'u1' },
          { id: 'u2' },
          { id: 'u3' },
        ]),
      },
      lead: {
        groupBy: jest.fn().mockResolvedValue([
          { assignedUserId: 'u1', _count: { _all: 5 } },
          { assignedUserId: 'u2', _count: { _all: 1 } },
          { assignedUserId: 'u3', _count: { _all: 3 } },
        ]),
      },
    } as never;
    await expect(pickRoundRobinAssignee(prisma, 't1', 'loc1')).resolves.toBe(
      'u2',
    );
  });

  it('does not assign when flag is off', async () => {
    const prisma = { user: { findMany: jest.fn() } } as never;
    await expect(
      resolveNewLeadAssignee(prisma, { roundRobinAssign: false }, {
        tenantId: 't1',
      }),
    ).resolves.toBeNull();
    expect(
      (prisma as { user: { findMany: jest.Mock } }).user.findMany,
    ).not.toHaveBeenCalled();
  });

  it('keeps an existing assignee', async () => {
    await expect(
      resolveNewLeadAssignee({} as never, { roundRobinAssign: true }, {
        tenantId: 't1',
        existingAssignedUserId: 'keep-me',
      }),
    ).resolves.toBe('keep-me');
  });
});
