import { evaluateExpression, formatNumber, loanPayment } from './calculator';

describe('conversation calculator', () => {
  it.each([
    ['17% of $42,500', 7225],
    ['0.17 * 42500', 7225],
    ['(45000 + 5000)', 50000],
    ['2^10', 1024],
    ['-3 + 5 * 2', 7],
    ['sqrt(144) + round(2.345, 2)', 14.35],
    ['1,250,000 / 4', 312500],
    ['15% * 80', 12],
    ['max(3, 9, 4) - min(3, 9, 4)', 6],
    ['2 ** 3 ** 2', 512],
  ])('%s = %s', (expr, want) => {
    expect(evaluateExpression(expr)).toBeCloseTo(want, 8);
  });

  it.each(['', '2 +', 'process.exit(1)', 'a.b', '1/0', '(1', 'constructor()'])(
    'rejects %j',
    (expr) => {
      expect(() => evaluateExpression(expr)).toThrow();
    },
  );

  it('formats without float noise', () => {
    expect(formatNumber(0.1 + 0.2)).toBe('0.3');
    expect(formatNumber(7225)).toBe('7225');
  });

  it('amortizes a standard loan', () => {
    const r = loanPayment({
      price: 40000,
      annualRatePercent: 6,
      termMonths: 60,
    });
    expect(r.monthlyPayment).toBeCloseTo(773.31, 2);
    expect(r.amountFinanced).toBe(40000);
    expect(r.totalInterest).toBeCloseTo(6398.6, 1);
  });

  it('applies down payment, trade and tax on price minus trade', () => {
    const r = loanPayment({
      price: 30000,
      annualRatePercent: 0,
      termMonths: 60,
      downPayment: 3000,
      tradeInValue: 5000,
      salesTaxPercent: 10,
    });
    expect(r.salesTax).toBe(2500);
    expect(r.amountFinanced).toBe(24500);
    expect(r.monthlyPayment).toBeCloseTo(408.33, 2);
  });

  it('rejects nonsense inputs', () => {
    expect(() =>
      loanPayment({ price: 0, annualRatePercent: 5, termMonths: 60 }),
    ).toThrow();
    expect(() =>
      loanPayment({ price: 100, annualRatePercent: 5, termMonths: 0 }),
    ).toThrow();
    expect(() =>
      loanPayment({ price: 100, annualRatePercent: -1, termMonths: 12 }),
    ).toThrow();
  });
});
