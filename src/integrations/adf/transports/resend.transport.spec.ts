import { readLeadDeliveryEnv } from '../lead-delivery-gates';
import { evaluateSendGates } from '../lead-delivery-gates';
import {
  LeadTransportError,
  OutboundLeadMessage,
} from './lead-delivery-transport';
import {
  buildResendPayload,
  classifyResendStatus,
  FetchLike,
  resendEmailIdFromStatus,
  resendIdempotencyKey,
  ResendLeadTransport,
} from './resend.transport';

const KEY = 're_test_key_never_real_0000';
const EMAIL_ID = '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794';
const XML =
  '<?xml version="1.0" encoding="UTF-8"?>\n<?adf version="1.0"?>\n<adf><prospect status="new"></prospect></adf>';

const msg = (over: Partial<OutboundLeadMessage> = {}): OutboundLeadMessage => ({
  deliveryId: 'del_1',
  tenantId: 't1',
  routeId: 'r1',
  routeEnvironment: 'PRODUCTION',
  correlationId: 'corr_1',
  messageId: '<lead-delivery.del_1@dialdifference.com>',
  from: 'leads@dialdifference.com',
  to: 'crm-inbox@store.example.net',
  subject: 'New lead amqur-lead-1',
  xml: XML,
  format: 'XML_BODY',
  date: new Date('2026-11-25T12:00:00Z'),
  ...over,
});

const liveEnv = (extra: Record<string, string> = {}) =>
  readLeadDeliveryEnv({
    NODE_ENV: 'production',
    ADF_SEND_ENABLED: 'true',
    LEAD_DELIVERY_MODE: 'live',
    RESEND_API_KEY: KEY,
    ADF_FROM_ADDRESS: 'leads@dialdifference.com',
    ...extra,
  });

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
  const impl: FetchLike = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve({ status, json: () => Promise.resolve(body) });
  };
  return { impl, calls };
}

describe('Resend lead transport', () => {
  it('sends the ADF document as the plain-text body, with no HTML part', () => {
    const p = buildResendPayload(msg());
    expect(p).toEqual({
      from: 'leads@dialdifference.com',
      to: ['crm-inbox@store.example.net'],
      subject: 'New lead amqur-lead-1',
      text: XML,
      headers: {
        'X-AMQUR-Delivery-Id': 'del_1',
        'X-AMQUR-Correlation-Id': 'corr_1',
        'Auto-Submitted': 'auto-generated',
        'X-AMQUR-Message-Id': '<lead-delivery.del_1@dialdifference.com>',
      },
    });
    expect(p).not.toHaveProperty('html');
    expect(p).not.toHaveProperty('cc');
    expect(p).not.toHaveProperty('bcc');
  });

  it('attachment routes carry the exact document, base64, as application/xml', () => {
    const p = buildResendPayload(msg({ format: 'XML_ATTACHMENT' }));
    expect(p.attachments).toHaveLength(1);
    const a = p.attachments![0];
    expect(a.filename).toBe('lead.adf.xml');
    expect(a.contentType).toBe('application/xml; charset=utf-8');
    expect(Buffer.from(a.content, 'base64').toString('utf8')).toBe(XML);
  });

  it('refuses header injection before any request', async () => {
    const f = fakeFetch(200, { id: EMAIL_ID });
    await expect(
      new ResendLeadTransport().send(
        msg({ subject: 'x\r\nBcc: attacker@example.com' }),
        { live: true },
        liveEnv(),
        f.impl,
      ),
    ).rejects.toBeDefined();
    expect(f.calls).toHaveLength(0);
  });

  it('posts once to the Resend API with a bearer key and an idempotency key', async () => {
    const f = fakeFetch(200, { id: EMAIL_ID });
    const r = await new ResendLeadTransport().send(
      msg(),
      { live: true },
      liveEnv(),
      f.impl,
    );
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe('https://api.resend.com/emails');
    expect(f.calls[0].init.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(f.calls[0].init.headers['Idempotency-Key']).toBe(
      resendIdempotencyKey(msg()),
    );
    expect(r).toMatchObject({
      accepted: true,
      providerName: 'resend',
      providerMessageId: '<lead-delivery.del_1@dialdifference.com>',
      rawStatus: `resend_accepted email_id=${EMAIL_ID}`,
    });
    // The key never appears in the receipt.
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(resendEmailIdFromStatus(r.rawStatus)).toBe(EMAIL_ID);
  });

  it('the idempotency key is stable per delivery and document, and changes with either', () => {
    const k = resendIdempotencyKey(msg());
    expect(k).toBe(resendIdempotencyKey(msg({ date: new Date() })));
    expect(k).not.toBe(resendIdempotencyKey(msg({ deliveryId: 'del_2' })));
    expect(k).not.toBe(resendIdempotencyKey(msg({ xml: XML + ' ' })));
    expect(k.length).toBeLessThanOrEqual(256);
  });

  it('never sends outside live mode, for a sandbox route, or without a key', async () => {
    const f = fakeFetch(200, { id: EMAIL_ID });
    const t = new ResendLeadTransport();
    await expect(
      t.send(msg(), { live: false }, liveEnv(), f.impl),
    ).rejects.toMatchObject({ code: 'resend_live_only', retryable: false });
    await expect(
      t.send(
        msg({ routeEnvironment: 'SANDBOX' }),
        { live: true },
        liveEnv(),
        f.impl,
      ),
    ).rejects.toMatchObject({ code: 'resend_requires_production_route' });
    await expect(
      t.send(msg(), { live: true }, liveEnv({ RESEND_API_KEY: '' }), f.impl),
    ).rejects.toMatchObject({ code: 'resend_not_configured' });
    expect(f.calls).toHaveLength(0);
  });

  it('classifies failures without leaking anything', async () => {
    expect(classifyResendStatus(401)).toMatchObject({
      code: 'resend_auth_failed',
      retryable: false,
    });
    expect(classifyResendStatus(422).retryable).toBe(false);
    expect(classifyResendStatus(409).retryable).toBe(true);
    expect(classifyResendStatus(429).retryable).toBe(true);
    expect(classifyResendStatus(503).retryable).toBe(true);
    const boom: FetchLike = () =>
      Promise.reject(new Error(`connect failed with Bearer ${KEY}`));
    const err = (await new ResendLeadTransport()
      .send(msg(), { live: true }, liveEnv(), boom)
      .catch((e: unknown) => e)) as LeadTransportError;
    expect(err).toBeInstanceOf(LeadTransportError);
    expect(err.code).toBe('resend_network_error');
    expect(err.message).not.toContain(KEY);
    // 2xx without an id is not an acceptance.
    await expect(
      new ResendLeadTransport().send(
        msg(),
        { live: true },
        liveEnv(),
        fakeFetch(200, {}).impl,
      ),
    ).rejects.toMatchObject({ code: 'resend_no_email_id', retryable: true });
  });

  it('live gate picks resend only when a key is configured', () => {
    const route = {
      id: 'r1',
      tenantId: 't1',
      locationId: 'l1',
      environment: 'PRODUCTION' as const,
      enabled: true,
      verified: true,
      productionEnabled: true,
    };
    const lead = {
      tenantId: 't1',
      locationId: 'l1',
      hasContactMethod: true,
      optedOut: false,
      spam: false,
    };
    const gate = (env: ReturnType<typeof liveEnv>, r = route) =>
      evaluateSendGates({ env, flagEnabled: true, lead, route: r });
    expect(gate(liveEnv())).toEqual({
      open: true,
      mode: 'live',
      transport: 'resend',
    });
    expect(gate(liveEnv({ RESEND_API_KEY: '' }))).toMatchObject({
      transport: 'smtp',
    });
    // An unverified or not-production-enabled route stays closed whatever the transport.
    expect(gate(liveEnv(), { ...route, verified: false })).toEqual({
      open: false,
      reason: 'route_unverified',
    });
    expect(gate(liveEnv(), { ...route, productionEnabled: false })).toEqual({
      open: false,
      reason: 'route_not_production_enabled',
    });
  });
});
