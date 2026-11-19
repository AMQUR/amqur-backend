import { SmtpLeadTransport } from './smtp.transport';
import { OutboundLeadMessage } from './lead-delivery-transport';
import { readLeadDeliveryEnv } from '../lead-delivery-gates';

/**
 * TLS policy of the SMTP transport, without a network: nodemailer is replaced by a recorder.
 * Reserved example.invalid hosts / addresses only.
 */
const createTransport = jest.fn();
jest.mock('nodemailer', () => ({
  createTransport: (opts: unknown) => createTransport(opts) as unknown,
}));

const message = (
  over: Partial<OutboundLeadMessage> = {},
): OutboundLeadMessage => ({
  deliveryId: 'delivery-1',
  tenantId: 'tenant-1',
  routeId: 'route-1',
  correlationId: 'corr-1',
  messageId: '<lead-delivery.delivery-1@amqur.example.invalid>',
  from: 'leads@amqur.example.invalid',
  to: 'adf-sales@crm.example.invalid',
  subject: 'New lead amqur-lead-1',
  xml: '<?xml version="1.0" encoding="UTF-8"?><adf></adf>',
  format: 'XML_BODY',
  date: new Date('2026-11-18T10:00:00Z'),
  ...over,
});

describe('SMTP transport — TLS and tier policy (no network)', () => {
  const sendMail = jest.fn();
  beforeEach(() => {
    createTransport.mockReset();
    sendMail.mockReset();
    sendMail.mockResolvedValue({
      accepted: ['adf-sales@crm.example.invalid'],
      rejected: [],
      messageId: '<m1@relay.example.invalid>',
      response: '250 2.0.0 OK',
    });
    createTransport.mockReturnValue({ sendMail, close: jest.fn() });
  });
  const opts = () =>
    createTransport.mock.calls[0][0] as Record<string, unknown>;
  const liveEnv = (over: Record<string, string> = {}) =>
    readLeadDeliveryEnv({
      NODE_ENV: 'production',
      ADF_SEND_ENABLED: 'true',
      LEAD_DELIVERY_MODE: 'live',
      ADF_SMTP_HOST: 'smtp.relay.example.invalid',
      ADF_SMTP_PORT: '587',
      ...over,
    });

  it('live on a STARTTLS port: requireTLS is set and TLS is never ignored', async () => {
    const receipt = await new SmtpLeadTransport().send(
      message({ routeEnvironment: 'PRODUCTION' }),
      { live: true },
      liveEnv(),
    );
    expect(receipt.accepted).toBe(true);
    expect(opts()).toMatchObject({
      host: 'smtp.relay.example.invalid',
      port: 587,
      secure: false,
      requireTLS: true,
      ignoreTLS: false,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  });

  it('live with implicit TLS (ADF_SMTP_SECURE=true): secure connection, STARTTLS not needed, TLS not ignored', async () => {
    await new SmtpLeadTransport().send(
      message(),
      { live: true },
      liveEnv({ ADF_SMTP_SECURE: 'true', ADF_SMTP_PORT: '465' }),
    );
    expect(opts()).toMatchObject({
      secure: true,
      requireTLS: false,
      ignoreTLS: false,
    });
  });

  it('sandbox (loopback mock) never requires TLS — and only ever a loopback host', async () => {
    const env = readLeadDeliveryEnv({
      NODE_ENV: 'test',
      ADF_SEND_ENABLED: 'true',
      ADF_SMTP_HOST: '127.0.0.1',
    });
    await new SmtpLeadTransport().send(message(), { live: false }, env);
    expect(opts()).toMatchObject({
      host: '127.0.0.1',
      requireTLS: false,
      ignoreTLS: true,
    });
  });

  it('sandbox SMTP: refused in the production tier, refused for a PRODUCTION route in any tier, allowed on hosted staging for a SANDBOX route', async () => {
    const t = new SmtpLeadTransport();
    const base = { ADF_SEND_ENABLED: 'true', ADF_SMTP_HOST: '127.0.0.1' };
    await expect(
      t.send(
        message(),
        { live: false },
        readLeadDeliveryEnv({ ...base, NODE_ENV: 'production' }),
      ),
    ).rejects.toMatchObject({ code: 'sandbox_in_production' });
    const staging = readLeadDeliveryEnv({
      ...base,
      NODE_ENV: 'production',
      DEPLOYMENT_TIER: 'staging',
    });
    await expect(
      t.send(
        message({ routeEnvironment: 'PRODUCTION' }),
        { live: false },
        staging,
      ),
    ).rejects.toMatchObject({
      code: 'production_route_in_sandbox',
      retryable: false,
    });
    expect(createTransport).not.toHaveBeenCalled();
    await expect(
      t.send(
        message({ routeEnvironment: 'SANDBOX' }),
        { live: false },
        staging,
      ),
    ).resolves.toMatchObject({ accepted: true });
  });
});
