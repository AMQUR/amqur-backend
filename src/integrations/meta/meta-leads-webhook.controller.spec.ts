import { ServiceUnavailableException } from '@nestjs/common';
import { MetaLeadsWebhookController } from './meta-leads-webhook.controller';
import { MetaLeadsWebhookService } from './meta-leads-webhook.service';

describe('MetaLeadsWebhookController', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.META_APP_SECRET;
    delete process.env.META_LEAD_WEBHOOK_TENANT_ID;
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('rejects with 503 not_configured when META_APP_SECRET is unset', async () => {
    const intake = {
      intake: jest.fn(),
      assertIntakeConfigured: jest.fn(),
    } as unknown as MetaLeadsWebhookService;
    const controller = new MetaLeadsWebhookController(intake);

    await expect(
      controller.leads(
        { rawBody: Buffer.from('{}'), body: {} } as never,
        undefined,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ reason: 'not_configured' }),
    });
    expect(intake.intake).not.toHaveBeenCalled();
  });

  it('surfaces not_configured as ServiceUnavailableException', async () => {
    const intake = {
      intake: jest.fn(),
    } as unknown as MetaLeadsWebhookService;
    const controller = new MetaLeadsWebhookController(intake);

    await expect(
      controller.leads(
        { rawBody: Buffer.from('{}'), body: {} } as never,
        'sha256=' + 'a'.repeat(64),
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
