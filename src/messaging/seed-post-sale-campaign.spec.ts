import {
  POST_SALE_CAMPAIGN_NAME,
  POST_SALE_CAMPAIGN_TEMPLATE,
  POST_SALE_TRIGGER,
  seedDisabledPostSaleCampaign,
} from './seed-post-sale-campaign';
import { renderTemplate } from './campaign.engine';

describe('seedDisabledPostSaleCampaign', () => {
  const upsert = jest.fn();
  const prisma = { followUpCampaign: { upsert } };

  beforeEach(() => {
    jest.resetAllMocks();
    upsert.mockResolvedValue({
      id: 'camp-1',
      enabled: false,
      trigger: POST_SALE_TRIGGER,
      name: POST_SALE_CAMPAIGN_NAME,
      template: POST_SALE_CAMPAIGN_TEMPLATE,
    });
  });

  it('uses only allowed template variables', () => {
    expect(
      renderTemplate(POST_SALE_CAMPAIGN_TEMPLATE, {
        firstName: 'Sam',
        dealerName: 'Demo Motors',
        appointmentDate: null,
        appointmentTime: null,
        vehicle: null,
      }),
    ).toContain('Sam');
  });

  it('upserts a disabled post-sale campaign', async () => {
    const row = await seedDisabledPostSaleCampaign(prisma as never, {
      tenantId: 'tenant-1',
      locationId: 'loc-1',
    });
    expect(row.enabled).toBe(false);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          tenantId: 'tenant-1',
          name: POST_SALE_CAMPAIGN_NAME,
          trigger: POST_SALE_TRIGGER,
          channel: 'SMS',
          enabled: false,
          template: POST_SALE_CAMPAIGN_TEMPLATE,
          locationId: 'loc-1',
        }),
        update: expect.not.objectContaining({ enabled: true }),
      }),
    );
    const createArg = upsert.mock.calls[0][0].create;
    expect(createArg.enabled).toBe(false);
    const updateArg = upsert.mock.calls[0][0].update;
    expect(updateArg).not.toHaveProperty('enabled');
  });
});
