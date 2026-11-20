import { commentToken, commentTokenOrUndefined } from './comment-token';

describe('commentToken', () => {
  it('accepts only 1-80 unreserved characters', () => {
    for (const ok of ['google', 'paid-social_2', 'fall.2026~a', 'a'.repeat(80)])
      expect(commentToken(ok)).toBe(ok);
    expect(commentToken('  widget  ')).toBe('widget');
    for (const bad of [
      '',
      'a b',
      'a;b',
      'a=b',
      'a:b',
      'a,b',
      'a(b)',
      'a\nb',
      'é',
      'a'.repeat(81),
      null,
      undefined,
      7,
      {},
    ])
      expect(commentToken(bad)).toBe('');
  });

  it('DTO transform drops unsafe strings and passes non-strings to validation', () => {
    expect(commentTokenOrUndefined('x; y')).toBeUndefined();
    expect(commentTokenOrUndefined('ok')).toBe('ok');
    expect(commentTokenOrUndefined(5)).toBe(5);
    expect(commentTokenOrUndefined(undefined)).toBeUndefined();
  });
});
