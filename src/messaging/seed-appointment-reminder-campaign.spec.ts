import {
  APPOINTMENT_REMINDER_CAMPAIGN_NAME,
  APPOINTMENT_REMINDER_CAMPAIGN_TEMPLATE,
  APPOINTMENT_REMINDER_TRIGGER,
  seedDisabledAppointmentReminderCampaign,
} from './seed-appointment-reminder-campaign';
import { renderTemplate } from './campaign.engine';

describe('seedDisabledAppointmentReminderCampaign', () => {
  const upsert = jest.fn();
  const prisma = { followUpCampaign: { upsert } };

  beforeEach(() => {
    jest.resetAllMocks();
    upsert.mockResolvedValue({
      id: 'camp-1',
      enabled: false,
      trigger: APPOINTMENT_REMINDER_TRIGGER,
      name: APPOINTMENT_REMINDER_CAMPAIGN_NAME,
      template: APPOINTMENT_REMINDER_CAMPAIGN_TEMPLATE,
    });
  });

  it('uses only allowed template variables', () => {
    expect(
      renderTemplate(APPOINTMENT_REMINDER_CAMPAIGN_TEMPLATE, {
        firstName: 'Sam',
        dealerName: 'Demo Motors',
        appointmentDate: 'Mon 3/10',
        appointmentTime: '2:00 PM',
        vehicle: '2024 Wrangler',
      }),
    ).toContain('Sam');
  });

  it('upserts a disabled appointment reminder campaign', async () => {
    const row = await seedDisabledAppointmentReminderCampaign(prisma as never, {
      tenantId: 'tenant-1',
      locationId: 'loc-1',
    });
    expect(row.enabled).toBe(false);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          tenantId: 'tenant-1',
          name: APPOINTMENT_REMINDER_CAMPAIGN_NAME,
          trigger: APPOINTMENT_REMINDER_TRIGGER,
          channel: 'SMS',
          enabled: false,
          template: APPOINTMENT_REMINDER_CAMPAIGN_TEMPLATE,
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
