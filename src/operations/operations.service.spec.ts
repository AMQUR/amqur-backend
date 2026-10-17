import { OperationsService } from './operations.service';

describe('OperationsService.satisfaction', () => {
  const prisma = {
    analyticsEvent: { count: jest.fn().mockResolvedValue(4) },
  };
  const deps = [
    prisma,
    {},
    {},
    {},
    {},
    {},
  ] as unknown as ConstructorParameters<typeof OperationsService>;

  let svc: OperationsService;

  beforeEach(() => {
    jest.clearAllMocks();
    svc = new OperationsService(...deps);
    jest.spyOn(svc, 'overview').mockResolvedValue({
      window: '7d',
      attention: { openHandoffs: 2 },
      aiQuality: {
        replyFeedback: {
          total: 8,
          good: 6,
          goodRate: 0.75,
          neededHuman: 1,
          tooLong: 0,
          robotic: 0,
          wrongFacts: 0,
          wrongQuestion: 0,
          unnecessaryRapport: 0,
          byLabel: {},
        },
        inventoryMisses: 0,
        knowledgeMisses: 0,
      },
    } as Awaited<ReturnType<OperationsService['overview']>>);
  });

  it('returns available:false with proxy signals (no CSAT score)', async () => {
    const r = await svc.satisfaction({ tenantId: 'tenant-1', locationId: null });
    expect(r.available).toBe(false);
    expect(r.reason).toBe('survey_provider_not_connected');
    expect(r.signals.replyFeedback).toEqual({
      total: 8,
      good: 6,
      goodRate: 0.75,
      neededHuman: 1,
    });
    expect(r.signals.handoffs).toEqual({
      openEscalations: 2,
      handoffRequested7d: 4,
    });
    expect(prisma.analyticsEvent.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ eventType: 'handoff_requested' }),
      }),
    );
  });
});
