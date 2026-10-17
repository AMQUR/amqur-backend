import {
  normalizeEmail,
  normalizePhone,
  pickUniqueMatch,
} from './contact-identity';

describe('contact-identity', () => {
  it('normalizes US phones to +1…', () => {
    expect(normalizePhone('(312) 555-1212')).toBe('+13125551212');
    expect(normalizePhone('1-312-555-1212')).toBe('+13125551212');
    expect(normalizePhone('bad')).toBeNull();
  });

  it('normalizes emails', () => {
    expect(normalizeEmail('  Pat@Dealer.COM ')).toBe('pat@dealer.com');
    expect(normalizeEmail('not-an-email')).toBeNull();
  });

  it('refuses ambiguous multi-matches', () => {
    const r = pickUniqueMatch([{ id: 'a' }, { id: 'b' }]);
    expect(r.status).toBe('AMBIGUOUS');
    expect(pickUniqueMatch([{ id: 'a' }, { id: 'a' }]).status).toBe('MATCHED');
    expect(pickUniqueMatch([]).status).toBe('NONE');
  });
});
