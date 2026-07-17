import {
  FeatureFlagsService,
  PLATFORM_FEATURE_DEFAULTS,
} from './feature-flags.service';

describe('FeatureFlagsService', () => {
  const prisma = {
    tenant: { findUnique: jest.fn() },
    location: { findFirst: jest.fn() },
    integrationConnection: { findFirst: jest.fn() },
  };
  const svc = new FeatureFlagsService(prisma as never);

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.tenant.findUnique.mockResolvedValue({ featureFlags: {} });
    prisma.location.findFirst.mockResolvedValue({ featureFlags: {} });
    prisma.integrationConnection.findFirst.mockResolvedValue(null);
  });

  it('defaults fail-closed for inventory/payments', async () => {
    const f = await svc.resolve('t1', 'l1');
    expect(f.inventory).toBe(false);
    expect(f.payments).toBe(false);
    expect(f.chat).toBe(PLATFORM_FEATURE_DEFAULTS.chat);
    expect(f.voiceAi).toBe(false);
  });

  it('tenant overrides enable inventory', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      featureFlags: {
        inventory: true,
        payments: true,
        financeCalculator: true,
      },
    });
    const f = await svc.resolve('t1', null);
    expect(f.inventory).toBe(true);
    expect(f.payments).toBe(true);
  });

  it('location overrides beat tenant', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      featureFlags: { inventory: true },
    });
    prisma.location.findFirst.mockResolvedValue({
      featureFlags: { inventory: false },
    });
    const f = await svc.resolve('t1', 'l1');
    expect(f.inventory).toBe(false);
  });

  it('hard-gates tekionIntegration without liveReady', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      featureFlags: { tekionIntegration: true },
    });
    prisma.integrationConnection.findFirst.mockResolvedValue(null);
    const f = await svc.resolve('t1', 'l1');
    expect(f.tekionIntegration).toBe(false);
  });

  it('forWidget is fail-closed boolean subset', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      featureFlags: {
        chat: true,
        inventory: true,
        payments: true,
        financeCalculator: true,
        proactiveEngagement: true,
        multilingual: true,
      },
    });
    const w = await svc.forWidget('t1', 'l1');
    expect(w.chat).toBe(true);
    expect(w.inventory).toBe(true);
    expect(w.payments).toBe(true);
    expect(w.voiceAi).toBe(false);
    expect(w.proactiveEngagement).toBe(true);
  });

  it('forWidget payments requires financeCalculator', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      featureFlags: { payments: true, financeCalculator: false },
    });
    const w = await svc.forWidget('t1', 'l1');
    expect(w.payments).toBe(false);
  });
});
