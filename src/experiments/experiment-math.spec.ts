import {
  assignVariant,
  compareRates,
  validateVariants,
} from './experiment-math';

describe('experiments', () => {
  const vs = [
    { key: 'control', weight: 50, text: 'Hey there! How’s your day going?' },
    {
      key: 'warm',
      weight: 50,
      text: 'Hi! Happy to help with anything car-related today.',
    },
  ];
  it('assignment is stable and roughly follows weights', () => {
    expect(assignVariant('conv-1', 'greet', vs).key).toBe(
      assignVariant('conv-1', 'greet', vs).key,
    );
    let warm = 0;
    for (let i = 0; i < 10_000; i += 1)
      if (assignVariant(`c${i}`, 'greet', vs).key === 'warm') warm += 1;
    expect(warm).toBeGreaterThan(4_700);
    expect(warm).toBeLessThan(5_300);
  });
  it('refuses prices, offers, approvals and urgency in copy', () => {
    for (const bad of [
      'Save $2,000 today!',
      '0% APR this week',
      'You are pre-approved!',
      'Hurry, selling fast',
    ])
      expect(() =>
        validateVariants([vs[0], { key: 'x', weight: 1, text: bad }]),
      ).toThrow();
    expect(validateVariants(vs)).toHaveLength(2);
  });
  it('never declares a winner below the minimum sample', () => {
    expect(
      compareRates({ n: 50, conversions: 5 }, { n: 50, conversions: 20 })
        .sufficient,
    ).toBe(false);
    const r = compareRates(
      { n: 2000, conversions: 200 },
      { n: 2000, conversions: 260 },
    );
    expect(r.sufficient).toBe(true);
    expect(r.pValue!).toBeLessThan(0.01);
    const flat = compareRates(
      { n: 2000, conversions: 200 },
      { n: 2000, conversions: 205 },
    );
    expect(flat.pValue!).toBeGreaterThan(0.5);
  });
});
