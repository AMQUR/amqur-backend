import { CampaignEngine } from './campaign.engine';

describe('CampaignEngine.stepAnalytics', () => {
  it('counts queued, suppressed, and customer replies for one campaign only', async () => {
    const prisma = {
      followUpCampaign: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'camp-1',
          name: 'Reminders',
          trigger: 'appointment.confirmed.reminder',
        }),
      },
      analyticsEvent: {
        findMany: jest.fn().mockResolvedValue([
          {
            eventType: 'campaign.step_queued',
            properties: { campaignId: 'camp-1' },
          },
          {
            eventType: 'campaign.step_suppressed',
            properties: { campaignId: 'camp-1', reason: 'quiet_hours' },
          },
          {
            eventType: 'campaign.customer_reply',
            properties: { campaignId: 'camp-1', bookingIntent: true },
          },
          {
            eventType: 'campaign.customer_reply',
            properties: { campaignId: 'other', bookingIntent: true },
          },
          {
            eventType: 'deal.sold_recorded',
            properties: { campaignId: 'camp-1', dmsDealId: 'D1' },
          },
        ]),
      },
    };
    const engine = new CampaignEngine(
      prisma as never,
      {} as never,
      { resolve: async () => ({ automatedFollowup: false }) } as never,
    );
    const r = await engine.stepAnalytics('t1', 'camp-1', 7);
    expect(r).toMatchObject({
      campaignId: 'camp-1',
      queued: 1,
      suppressed: 1,
      customerReplies: 1,
      bookingIntentReplies: 1,
      soldAttributed: 1,
      suppressReasons: { quiet_hours: 1 },
    });
    expect(r?.note).toMatch(/persisted analytics/i);
  });
});
