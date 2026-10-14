import {
  signWebhookPayload,
  verifyWebhookSignature,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} from './webhook-signature';
import {
  detectCreditSensitive,
  redactCreditSensitive,
  redactForLlm,
  redactForLog,
} from './sensitive-data';
import {
  validateCreditConfig,
  CreditApplicationService,
} from '../../finance/credit-application.service';
import { ConversationIdService } from '../../chat/conversation-id.service';
import { upgradeState } from '../../chat/memory/journey.store';

const SECRET = 'whsec_test_0123456789abcdef0123456789';

describe('webhook HMAC (AMQUR generic)', () => {
  const raw = '{"event":"x","n":1}';
  const now = 1_791_900_000;

  it('verifies a valid signature over the RAW body', () => {
    const h = signWebhookPayload(raw, SECRET, 'evt_1', now);
    expect(
      verifyWebhookSignature({
        rawBody: raw,
        signatureHeader: h[SIGNATURE_HEADER],
        timestampHeader: h[TIMESTAMP_HEADER],
        eventId: 'evt_1',
        secrets: [SECRET],
        nowSeconds: now,
      }).ok,
    ).toBe(true);
  });

  it('rejects re-serialized JSON, wrong event id, stale timestamp, and missing secret', () => {
    const h = signWebhookPayload(raw, SECRET, 'evt_1', now);
    const base = {
      signatureHeader: h[SIGNATURE_HEADER],
      timestampHeader: h[TIMESTAMP_HEADER],
      secrets: [SECRET],
      nowSeconds: now,
    };
    expect(
      verifyWebhookSignature({
        ...base,
        rawBody: '{"n":1,"event":"x"}',
        eventId: 'evt_1',
      }).ok,
    ).toBe(false);
    expect(
      verifyWebhookSignature({ ...base, rawBody: raw, eventId: 'evt_2' }).ok,
    ).toBe(false);
    expect(
      verifyWebhookSignature({
        ...base,
        rawBody: raw,
        eventId: 'evt_1',
        nowSeconds: now + 3600,
      }),
    ).toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' });
    expect(
      verifyWebhookSignature({
        ...base,
        rawBody: raw,
        eventId: 'evt_1',
        secrets: [],
      }),
    ).toEqual({ ok: false, reason: 'no_secret_configured' });
  });

  it('supports secret rotation (previous secret still accepted)', () => {
    const h = signWebhookPayload(raw, SECRET, 'evt_1', now);
    const r = verifyWebhookSignature({
      rawBody: raw,
      signatureHeader: h[SIGNATURE_HEADER],
      timestampHeader: h[TIMESTAMP_HEADER],
      eventId: 'evt_1',
      secrets: ['whsec_new_secret_value_0000000000', SECRET],
      nowSeconds: now,
    });
    expect(r).toEqual({ ok: true, secretIndex: 1 });
  });
});

describe('sensitive data handling', () => {
  it('detects and redacts SSN / Luhn-valid cards / bank details / passwords', () => {
    const msg =
      'ssn 123-45-6789, card 4111 1111 1111 1111, routing number 021000021, account # 123456789, password: hunter2';
    expect(detectCreditSensitive(msg)).toEqual(
      expect.arrayContaining([
        'ssn',
        'card',
        'routing',
        'bank_account',
        'password',
      ]),
    );
    const out = redactCreditSensitive(msg);
    for (const s of [
      '123-45-6789',
      '4111 1111 1111 1111',
      '021000021',
      '123456789',
      'hunter2',
    ])
      expect(out).not.toContain(s);
  });

  it('does not treat a VIN or a price as sensitive', () => {
    expect(
      detectCreditSensitive('VIN 1C4RJFBG0MC100001 listed at $41,995'),
    ).toEqual([]);
  });

  it('strips contact PII before LLM egress but keeps VINs', () => {
    const out = redactForLlm(
      'I am sam@example.com, 312-555-0142, VIN 1C4RJFBG0MC100001',
    );
    expect(out).not.toMatch(/sam@example.com|312-555-0142/);
    expect(out).toContain('1C4RJFBG0MC100001');
  });

  it('log redaction masks bearer tokens and auth headers', () => {
    expect(
      redactForLog('Authorization: Bearer abc.def.ghi cookie=sid=123'),
    ).not.toMatch(/abc\.def|sid=123/);
  });
});

describe('credit application config', () => {
  const ok = {
    enabled: true,
    url: 'https://apply.dealer.test/app',
    allowedHosts: ['apply.dealer.test'],
    lastVerifiedAt: '2026-10-01T00:00:00Z',
  };
  it('accepts only https + allowlisted + staff-verified destinations', () => {
    expect(validateCreditConfig(ok).available).toBe(true);
    expect(
      validateCreditConfig({ ...ok, url: 'http://apply.dealer.test/app' }),
    ).toEqual({ available: false, reason: 'not_https' });
    expect(
      validateCreditConfig({ ...ok, url: 'https://evil.test/app' }),
    ).toEqual({ available: false, reason: 'host_not_allowlisted' });
    expect(validateCreditConfig({ ...ok, lastVerifiedAt: undefined })).toEqual({
      available: false,
      reason: 'not_verified',
    });
    expect(validateCreditConfig({ ...ok, enabled: false })).toEqual({
      available: false,
      reason: 'disabled',
    });
    expect(
      validateCreditConfig({
        ...ok,
        url: 'https://user:pw@apply.dealer.test/',
      }),
    ).toEqual({ available: false, reason: 'not_https' });
  });

  it('click tokens are opaque, signed, expiring and carry no PII', () => {
    const svc = new CreditApplicationService(
      {} as never,
      {
        get: (k: string) => (k === 'JWT_SECRET' ? 'x'.repeat(40) : undefined),
      } as never,
      {} as never,
    );
    const tok = svc.sign('fr_1', 't_1', 1_000);
    expect(svc.verify(tok, 2_000)).toEqual({
      financeRequestId: 'fr_1',
      tenantId: 't_1',
    });
    expect(svc.verify(tok.slice(0, -2) + 'xx', 2_000)).toBeNull();
    expect(svc.verify(tok, 1_000 + 8 * 24 * 3600_000)).toBeNull();
    expect(Buffer.from(tok.split('.')[0], 'base64url').toString()).not.toMatch(
      /@|\d{10}/,
    );
  });
});

describe('conversation ids', () => {
  const svc = new ConversationIdService({
    get: (k: string) => (k === 'JWT_SECRET' ? 'y'.repeat(40) : undefined),
  } as never);
  it('are tenant-bound and unforgeable', () => {
    const id = svc.issue('tenantA');
    expect(svc.verify('tenantA', id)).toBe(true);
    expect(svc.verify('tenantB', id)).toBe(false);
    expect(svc.verify('tenantA', 'test')).toBe(false);
    expect(
      svc.verify(
        'tenantA',
        id.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')),
      ),
    ).toBe(false);
  });
});

describe('legacy conversation state upgrade', () => {
  it('preserves customer context from v1 rows', () => {
    const s = upgradeState({
      selectedVin: 'V1',
      visibleVins: ['V1', 'V2'],
      maxPrice: 40000,
      lead: { firstName: 'Sam', phone: '3125550142' },
      conversationTurnCount: 4,
    });
    expect(s).toMatchObject({
      v: 2,
      selectedVin: 'V1',
      visibleVins: ['V1', 'V2'],
      criteria: { maxPrice: 40000 },
      contact: { firstName: 'Sam', phone: '3125550142' },
      turnCount: 4,
    });
  });
});
