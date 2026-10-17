import { MetaLeadsWebhookService } from './meta-leads-webhook.service';

describe('MetaLeadsWebhookService.verifyHubSubscription', () => {
  const OLD_ENV = process.env;
  const svc = new MetaLeadsWebhookService({} as never);

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.META_WEBHOOK_VERIFY_TOKEN;
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('returns not_configured when verify token env is missing', () => {
    expect(
      svc.verifyHubSubscription({
        mode: 'subscribe',
        verifyToken: 'x',
        challenge: '123',
      }),
    ).toEqual({ ok: false, reason: 'not_configured' });
  });

  it('rejects token mismatch', () => {
    process.env.META_WEBHOOK_VERIFY_TOKEN = 'expected';
    expect(
      svc.verifyHubSubscription({
        mode: 'subscribe',
        verifyToken: 'wrong',
        challenge: '123',
      }),
    ).toEqual({ ok: false, reason: 'token_mismatch' });
  });

  it('returns challenge on valid subscribe handshake', () => {
    process.env.META_WEBHOOK_VERIFY_TOKEN = 'expected';
    expect(
      svc.verifyHubSubscription({
        mode: 'subscribe',
        verifyToken: 'expected',
        challenge: 'challenge-abc',
      }),
    ).toEqual({ ok: true, challenge: 'challenge-abc' });
  });
});
