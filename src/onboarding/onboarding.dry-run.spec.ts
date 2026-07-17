import { OnboardingService } from './onboarding.service';

describe('OnboardingService dry-run', () => {
  function makeService() {
    const tx = {
      dealerGroup: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'g1' }),
      },
      tenant: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: 't1',
          slug: 'dry-run-motors',
          name: 'Dry Run Motors',
          configVersion: 1,
          publicConfig: {},
          featureFlags: {},
        }),
      },
      location: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: 'l1',
          slug: 'main',
          name: 'Main',
        }),
      },
      user: { findUnique: jest.fn(), create: jest.fn() },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      // Real Prisma rolls back when the callback throws; emulate that.
      $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) =>
        fn(tx),
      ),
    };
    const publicService = {
      invalidateWidgetConfigCache: jest.fn().mockResolvedValue(undefined),
    };
    return {
      svc: new OnboardingService(prisma as never, publicService as never),
      tx,
      publicService,
    };
  }

  const dto = {
    tenantName: 'Dry Run Motors',
    tenantSlug: 'dry-run-motors',
    locationName: 'Main',
    locationSlug: 'main',
  } as never;

  it('returns the would-be result without committing (dryRun: true)', async () => {
    const { svc, publicService } = makeService();
    const result = (await svc.onboard({
      ...(dto as object),
      dryRun: true,
    } as never)) as Record<string, unknown>;
    expect(result.dryRun).toBe(true);
    expect((result.tenant as { slug: string }).slug).toBe('dry-run-motors');
    // No cache invalidation for a rolled-back run.
    expect(publicService.invalidateWidgetConfigCache).not.toHaveBeenCalled();
  });

  it('commits and invalidates cache on a real run', async () => {
    const { svc, publicService } = makeService();
    const result = (await svc.onboard(dto)) as Record<string, unknown>;
    expect(result.dryRun).toBe(false);
    expect(publicService.invalidateWidgetConfigCache).toHaveBeenCalled();
  });

  it('propagates non-dry-run transaction failures', async () => {
    const { svc, tx } = makeService();
    tx.tenant.create.mockRejectedValue(new Error('db down'));
    await expect(svc.onboard(dto)).rejects.toThrow('db down');
  });
});
