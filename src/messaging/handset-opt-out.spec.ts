import {
  handsetOptOutStands,
  isHandsetConsentSource,
  textStaysOffText,
} from './handset-opt-out';

const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s));

describe('handset opt-out lock', () => {
  it('only SMS_KEYWORD and PROVIDER are handset/provider sources', () => {
    expect(isHandsetConsentSource('SMS_KEYWORD')).toBe(true);
    expect(isHandsetConsentSource('PROVIDER')).toBe(true);
    for (const s of ['WIDGET', 'STAFF', 'IMPORT', '', null, undefined, 7])
      expect(isHandsetConsentSource(s)).toBe(false);
  });

  it('stands while the latest handset record is an opt-out, regardless of other sources', () => {
    expect(handsetOptOutStands([])).toBe(false);
    expect(
      handsetOptOutStands([
        { source: 'WIDGET', granted: false, createdAt: at(1) },
      ]),
    ).toBe(false);
    const rows = [
      { source: 'SMS_KEYWORD', granted: false, createdAt: at(1) },
      { source: 'WIDGET', granted: true, createdAt: at(2) },
      { source: 'STAFF', granted: true, createdAt: at(3) },
    ];
    expect(handsetOptOutStands(rows)).toBe(true);
    expect(
      handsetOptOutStands([
        ...rows,
        { source: 'SMS_KEYWORD', granted: true, createdAt: at(4) },
      ]),
    ).toBe(false);
  });

  it('on a timestamp tie the opt-out wins', () => {
    expect(
      handsetOptOutStands([
        { source: 'SMS_KEYWORD', granted: true, createdAt: at(1) },
        { source: 'PROVIDER', granted: false, createdAt: at(1) },
      ]),
    ).toBe(true);
  });

  it('customer wording is neutral: no claim about the number having opted out', () => {
    for (const lang of ['en', 'es'] as const) {
      const text = textStaysOffText(lang);
      expect(text).toMatch(/START/);
      expect(text).not.toMatch(
        /opted out|opt-out|unsubscrib|STOP|previous|before|canceló|baja|anteriormente/i,
      );
    }
  });
});
