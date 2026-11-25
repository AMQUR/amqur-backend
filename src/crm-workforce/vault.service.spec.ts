import { auditSafe, CrmWfVaultKeyError, CrmWfVaultService, isReservedTestContact } from './vault.service';

describe('CRM Workforce vault', () => {
  const v = new CrmWfVaultService();
  const KEY = 'unit-test-data-key-0123456789-abcdefghij';
  let prev: Record<string, string | undefined>;
  beforeEach(() => {
    prev = { a: process.env.CRM_WORKFORCE_DATA_KEY, b: process.env.INTEGRATION_ENCRYPTION_KEY };
    process.env.CRM_WORKFORCE_DATA_KEY = KEY;
  });
  afterEach(() => {
    process.env.CRM_WORKFORCE_DATA_KEY = prev.a;
    process.env.INTEGRATION_ENCRYPTION_KEY = prev.b;
    if (prev.a === undefined) delete process.env.CRM_WORKFORCE_DATA_KEY;
    if (prev.b === undefined) delete process.env.INTEGRATION_ENCRYPTION_KEY;
  });

  it('seals so the stored value shows no contact data, and opens back exactly', () => {
    const c = v.sealContact({ lastName: 'Shopper', phone: '(312) 555-0142', email: 'Test.Person@Example.invalid' });
    const stored = JSON.stringify(c);
    for (const leak of ['Shopper', '5550142', '3125550142', 'example.invalid', 'Test.Person']) expect(stored).not.toContain(leak);
    expect(c.phoneLast4).toBe('0142');
    expect(v.open(c.phoneEnc)).toBe('+13125550142');
    expect(v.open(c.emailEnc)).toBe('test.person@example.invalid');
    expect(v.open(c.lastNameEnc)).toBe('Shopper');
  });

  it('uses a fresh nonce each time but a stable hash for lookup', () => {
    expect(v.seal('same')).not.toBe(v.seal('same'));
    const a = v.endpoint('SMS', '312-555-0142')!, b = v.endpoint('SMS', '+1 (312) 555 0142')!;
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hint).toBe('…0142');
    expect(v.endpoint('EMAIL', 'Someone@Example.invalid')!.hint).toBe('s…@example.invalid');
    expect(v.endpoint('SMS', '12')).toBeNull();
  });

  it('a different key cannot open the value and yields a different hash', () => {
    const sealed = v.seal('secret')!, h = v.hash('+13125550142');
    process.env.CRM_WORKFORCE_DATA_KEY = 'another-key-another-key-another-key-xyz';
    expect(() => v.open(sealed)).toThrow();
    expect(v.hash('+13125550142')).not.toBe(h);
  });

  it('detects tampering', () => {
    const sealed = v.seal('secret')!;
    const parts = sealed.split('.');
    parts[3] = Buffer.from('other').toString('base64url');
    expect(() => v.open(parts.join('.'))).toThrow();
  });

  it('fails closed without a key', () => {
    delete process.env.CRM_WORKFORCE_DATA_KEY;
    delete process.env.INTEGRATION_ENCRYPTION_KEY;
    expect(v.isReady()).toBe(false);
    expect(() => v.seal('x')).toThrow(CrmWfVaultKeyError);
    expect(() => v.hash('x')).toThrow(CrmWfVaultKeyError);
  });

  it('recognises reserved test contacts and nothing else', () => {
    expect(isReservedTestContact({ phone: '+13125550142', email: 'a@example.invalid' })).toBe(true);
    expect(isReservedTestContact({ phone: '(773) 555-0199' })).toBe(true);
    expect(isReservedTestContact({ email: 'x@dealer.test' })).toBe(true);
    expect(isReservedTestContact({})).toBe(true);
    expect(isReservedTestContact({ phone: '+13125551234' })).toBe(false);
    expect(isReservedTestContact({ phone: '+17734233000' })).toBe(false);
    expect(isReservedTestContact({ phone: '+13125550142', email: 'person@gmail.com' })).toBe(false);
  });

  it('scrubs contact details out of audit metadata', () => {
    const out = auditSafe({ reason: 'call me at 312-555-0142 or a@b.co', phone: '+13125550142', nested: { email: 'a@b.co', note: 'ssn 123-45-6789' }, n: 3 });
    expect(JSON.stringify(out)).not.toMatch(/5550142|a@b\.co|123-45-6789/);
    expect(out.n).toBe(3);
  });
});
