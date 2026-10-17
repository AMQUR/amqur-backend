import { CampaignEngine } from './campaign.engine';

describe('CampaignEngine.onEvent', () => {
  it('schedules campaign.step without checking consent (STOP enforced at execute via queue)', async () => {
    const outbox = { enqueue: jest.fn().mockResolvedValue({ id: 'ob-1' }) };
    const prisma = {
      followUpCampaign: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'camp-1',
            version: 3,
            policy: {},
            trigger: 'lead.no_response',
          },
        ]),
      },
    };
    const engine = new CampaignEngine(
      prisma as never,
      outbox as never,
      { registerHandler: jest.fn() } as never,
      {} as never,
      { resolve: async () => ({ automatedFollowup: true }) } as never,
    );

    const enrolledAt = new Date();
    await engine.onEvent({
      tenantId: 'tenant-1',
      trigger: 'lead.no_response',
      subjectId: 'lead-1',
      at: enrolledAt,
    });

    expect(outbox.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: 'campaign.step',
        idempotencyKey: 'campaign:camp-1:v3:lead-1',
      }),
    );
  });
});

describe('CampaignEngine.execute', () => {
  it('records step suppression when queue rejects opted-out endpoint after STOP', async () => {
    const messaging = {
      queue: jest
        .fn()
        .mockResolvedValue({ status: 'SUPPRESSED', reason: 'opted_out' }),
    };
    const analyticsCreate = jest.fn().mockResolvedValue({});
    const prisma = {
      followUpCampaign: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'camp-1',
          tenantId: 'tenant-1',
          enabled: true,
          version: 1,
          trigger: 'lead.no_response',
          template: 'Hi {firstName}',
          policy: {},
          locationId: null,
          startsAt: null,
          endsAt: null,
        }),
      },
      lead: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'lead-1',
          status: 'OPEN',
          conversationId: null,
          locationId: 'loc-1',
          phone: '+15551234567',
          firstName: 'Sam',
        }),
      },
      tenant: {
        findUnique: jest.fn().mockResolvedValue({ name: 'Demo Motors' }),
      },
      analyticsEvent: { create: analyticsCreate },
    };
    const engine = new CampaignEngine(
      prisma as never,
      {} as never,
      { registerHandler: jest.fn() } as never,
      messaging as never,
      { resolve: async () => ({ automatedFollowup: true }) } as never,
    );

    const result = await engine.execute({
      campaignId: 'camp-1',
      version: 1,
      subjectId: 'lead-1',
      enrolledAt: '2026-10-13T12:00:00.000Z',
    });

    expect(result).toEqual({ note: 'suppressed:opted_out' });
    expect(messaging.queue).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'CONVERSATIONAL',
        campaignId: 'camp-1',
        to: '+15551234567',
      }),
    );
    expect(analyticsCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: 'campaign.step_suppressed',
        properties: expect.objectContaining({
          campaignId: 'camp-1',
          reason: 'opted_out',
        }),
      }),
    });
  });
});
