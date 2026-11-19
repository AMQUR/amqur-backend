import {
  assertHeaderSafe,
  fingerprintDestination,
  isLoopbackHost,
  isReservedTestDomain,
  maskDestination,
  normalizeDestination,
  UnsafeHeaderValueError,
} from './destination';
import {
  buildLeadMailOptions,
  LeadTransportError,
  OutboundLeadMessage,
  sanitizeProviderStatus,
} from './transports/lead-delivery-transport';
import { SandboxSinkTransport } from './transports/sandbox-sink.transport';
import {
  assertSmtpTargetAllowed,
  classifySmtpError,
  SmtpLeadTransport,
} from './transports/smtp.transport';
import { readLeadDeliveryEnv } from './lead-delivery-gates';
import { serializeAdf } from './adf-serializer';
import { fixtureDto } from './adf-test-fixtures';

const xml = serializeAdf(fixtureDto(0));
const msg = (over: Partial<OutboundLeadMessage> = {}): OutboundLeadMessage => ({
  deliveryId: 'delivery-1',
  tenantId: 'tenant-1',
  routeId: 'route-1',
  correlationId: 'corr-1',
  messageId: '<lead-delivery.delivery-1@amqur.example.invalid>',
  from: 'adf-sandbox@amqur.example.invalid',
  to: 'adf-sales-chevy@leads.example.invalid',
  subject: 'New lead amqur-lead-1',
  xml,
  format: 'XML_BODY',
  date: new Date('2026-11-18T10:00:00Z'),
  ...over,
});

describe('destination helpers', () => {
  it('accepts exactly one bare mailbox', () => {
    expect(normalizeDestination(' Leads@Dealer-CRM.net ')).toBe(
      'leads@dealer-crm.net',
    );
    for (const bad of [
      'a@x.net, b@y.net',
      'a@x.net;b@y.net',
      'Leads <leads@x.net>',
      'leads@x.net\r\nBcc: evil@y.net',
      'leads@x',
      '@x.net',
      'leads@',
      '',
      null,
      42,
    ])
      expect(normalizeDestination(bad)).toBeNull();
  });

  it('masks and fingerprints without keeping the address', () => {
    expect(maskDestination('leads@dialexample.net')).toBe('l***@d***.net');
    const a = fingerprintDestination('leads@dialexample.net', 'k'.repeat(32));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(
      fingerprintDestination('leads@dialexample.net', 'k'.repeat(32)),
    );
    expect(a).not.toBe(
      fingerprintDestination('leads@dialexample.net', 'j'.repeat(32)),
    );
    expect(a).not.toContain('leads');
  });

  it('knows reserved test domains and loopback hosts', () => {
    for (const d of [
      'example.invalid',
      'leads.example.invalid',
      'x.test',
      'example.com',
      'a.example.org',
      'localhost',
    ])
      expect(isReservedTestDomain(d)).toBe(true);
    for (const d of [
      'dialchevy.net',
      'invalid.com',
      'testdealer.com',
      'example.co',
    ])
      expect(isReservedTestDomain(d)).toBe(false);
    for (const h of ['127.0.0.1', '::1', 'localhost', ' LOCALHOST '])
      expect(isLoopbackHost(h)).toBe(true);
    for (const h of [
      'smtp.sendgrid.net',
      '10.0.0.5',
      '0.0.0.0',
      'mock-smtp',
      '127.0.0.1.evil.net',
    ])
      expect(isLoopbackHost(h)).toBe(false);
  });
});

describe('RFC 5322 message + header-injection safety', () => {
  it('builds body and attachment variants with one recipient and no CC/BCC', () => {
    const body = buildLeadMailOptions(msg());
    expect(body).toMatchObject({
      from: 'adf-sandbox@amqur.example.invalid',
      to: 'adf-sales-chevy@leads.example.invalid',
      envelope: {
        from: 'adf-sandbox@amqur.example.invalid',
        to: ['adf-sales-chevy@leads.example.invalid'],
      },
      text: xml,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    expect(body).not.toHaveProperty('cc');
    expect(body).not.toHaveProperty('bcc');
    expect(body.attachments).toBeUndefined();
    const att = buildLeadMailOptions(msg({ format: 'XML_ATTACHMENT' }));
    expect(att.text).not.toContain('<adf>');
    expect(att.attachments).toEqual([
      {
        filename: 'lead.adf.xml',
        content: xml,
        contentType: 'application/xml; charset=utf-8',
      },
    ]);
  });

  it.each([
    ['to', { to: 'leads@x.example.invalid\r\nBcc: evil@example.invalid' }],
    ['to', { to: 'leads@x.example.invalid\nCc: evil@example.invalid' }],
    ['from', { from: 'a@amqur.example.invalid\r\nX-Injected: 1' }],
    ['subject', { subject: 'New lead\r\nBcc: evil@example.invalid' }],
    ['subject', { subject: 'New lead\rX: y' }],
    ['messageId', { messageId: '<a@b>\r\nBcc: evil@example.invalid' }],
    ['deliveryId', { deliveryId: 'd1\r\nBcc: evil@example.invalid' }],
    ['correlationId', { correlationId: 'c1\nX: y' }],
  ] as Array<[string, Partial<OutboundLeadMessage>]>)(
    'rejects CR/LF in %s',
    (field, over) => {
      expect(() => buildLeadMailOptions(msg(over))).toThrow(
        UnsafeHeaderValueError,
      );
      expect(() => buildLeadMailOptions(msg(over))).toThrow(
        `unsafe_header_value:${field}`,
      );
    },
  );

  it('rejects recipient lists, malformed ids and empty subjects', () => {
    expect(() =>
      buildLeadMailOptions(
        msg({ to: 'a@x.example.invalid, b@y.example.invalid' }),
      ),
    ).toThrow('bad_recipient_address');
    expect(() =>
      buildLeadMailOptions(msg({ messageId: 'no-brackets' })),
    ).toThrow('bad_message_id');
    expect(() => buildLeadMailOptions(msg({ subject: '' }))).toThrow(
      'bad_subject',
    );
    expect(assertHeaderSafe('x', 'plain value')).toBe('plain value');
  });

  it('provider status lines are stripped of anything address-like', () => {
    expect(sanitizeProviderStatus('250 2.0.0 OK queued as mock-1')).toBe(
      '250 2.0.0 OK queued as mock-1',
    );
    const s = sanitizeProviderStatus(
      '550 5.1.1 <leads@dealer-crm.net>: user person@dealer-crm.net unknown\r\nmore',
    );
    expect(s).not.toContain('@');
    expect(s).not.toMatch(/[\r\n]/);
    expect(sanitizeProviderStatus(undefined)).toBe('no_status');
  });
});

describe('sandbox sink transport', () => {
  it('records the full RFC 5322 message and returns a typed receipt', async () => {
    const sink = new SandboxSinkTransport();
    const receipt = await sink.send(msg());
    expect(receipt).toMatchObject({
      accepted: true,
      providerName: 'sandbox-sink',
      rawStatus: 'sandbox_sink_recorded',
    });
    expect(receipt.providerMessageId).toMatch(/^sink-[0-9a-f]{24}$/);
    expect(receipt.at).toBeInstanceOf(Date);
    const [rec] = sink.messages();
    expect(rec.to).toBe('adf-sales-chevy@leads.example.invalid');
    expect(rec.xml).toBe(xml);
    for (const header of [
      'Message-ID: <lead-delivery.delivery-1@amqur.example.invalid>',
      'From: adf-sandbox@amqur.example.invalid',
      'To: adf-sales-chevy@leads.example.invalid',
      'Subject: New lead amqur-lead-1',
      'Date: Wed, 18 Nov 2026 10:00:00 +0000',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
    ])
      expect(rec.raw).toContain(header);
    expect(rec.raw).not.toMatch(/^(Cc|Bcc):/im);
    sink.clear();
    expect(sink.messages()).toHaveLength(0);
  });

  it('attachment format produces a multipart message with the XML part', async () => {
    const sink = new SandboxSinkTransport();
    await sink.send(msg({ format: 'XML_ATTACHMENT' }));
    const raw = sink.messages()[0].raw;
    expect(raw).toMatch(/Content-Type: multipart\/mixed/);
    expect(raw).toMatch(/Content-Type: application\/xml/);
    expect(raw).toMatch(/filename="?lead\.adf\.xml"?/);
  });
});

describe('SMTP transport policy', () => {
  it('refuses any non-loopback host unless live is fully gated on', () => {
    for (const host of [
      'smtp.sendgrid.net',
      '10.1.2.3',
      'mock-smtp',
      '0.0.0.0',
    ])
      expect(() => assertSmtpTargetAllowed(host, false)).toThrow(
        'smtp_host_not_loopback',
      );
    for (const host of ['127.0.0.1', 'localhost', '::1'])
      expect(() => assertSmtpTargetAllowed(host, false)).not.toThrow();
    expect(() =>
      assertSmtpTargetAllowed('smtp.relay.example', true),
    ).not.toThrow();
  });

  it('send() rejects a non-loopback host before opening any connection', async () => {
    const env = readLeadDeliveryEnv({
      NODE_ENV: 'test',
      ADF_SEND_ENABLED: 'true',
      ADF_SMTP_HOST: 'smtp.unreachable.example.invalid',
    });
    const started = Date.now();
    await expect(
      new SmtpLeadTransport().send(msg(), { live: false }, env),
    ).rejects.toMatchObject({
      code: 'smtp_host_not_loopback',
      retryable: false,
    });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('classifies failures into PII-free retryable/permanent codes', () => {
    const c = (e: unknown) => {
      const r = classifySmtpError(e);
      return [r.code, r.retryable];
    };
    expect(c({ responseCode: 451, message: 'try later <a@b.net>' })).toEqual([
      'smtp_deferred_451',
      true,
    ]);
    expect(c({ responseCode: 550, message: 'no such user a@b.net' })).toEqual([
      'smtp_rejected_550',
      false,
    ]);
    expect(c({ code: 'ETIMEDOUT' })).toEqual(['smtp_etimedout', true]);
    expect(c({ code: 'ESOCKET' })).toEqual(['smtp_esocket', true]);
    expect(c({ code: 'EAUTH' })).toEqual(['smtp_auth_failed', false]);
    expect(c(new Error('leads@dealer-crm.net exploded'))).toEqual([
      'smtp_error',
      true,
    ]);
    const own = new LeadTransportError('bad_recipient_address', false);
    expect(classifySmtpError(own)).toBe(own);
  });
});
