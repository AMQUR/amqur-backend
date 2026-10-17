import { PaymentService } from './payment.service';

describe('PaymentService', () => {
  const service = new PaymentService();

  it('computes a stable amortization estimate', () => {
    const result = service.estimateFinance({
      price: 40000,
      termMonths: 60,
      apr: 6,
      downPayment: 4000,
      tradeIn: 0,
      fees: 0,
      taxRate: 0,
    });

    expect(result.amountFinanced).toBe(36000);
    expect(result.monthlyPayment).toBeGreaterThan(0);
    expect(result.monthlyPayment).toBeLessThan(36000 / 12);
    expect(result.breakdown.apr).toBe(6);
    expect(result.breakdown.termMonths).toBe(60);
  });

  it('handles 0% APR', () => {
    const result = service.estimateFinance({
      price: 12000,
      termMonths: 12,
      apr: 0,
      downPayment: 0,
      fees: 0,
      taxRate: 0,
    });
    expect(result.monthlyPayment).toBe(1000);
    expect(result.totalInterest).toBe(0);
  });

  it('never invents negative financed amounts', () => {
    const result = service.estimateFinance({
      price: 10000,
      termMonths: 36,
      apr: 5,
      downPayment: 20000,
      fees: 0,
      taxRate: 0,
    });
    expect(result.amountFinanced).toBe(0);
    expect(result.monthlyPayment).toBe(0);
  });

  it('exposes an educational disclaimer', () => {
    expect(service.estimateDisclaimer.toLowerCase()).toContain('estimate');
    expect(service.estimateDisclaimer.toLowerCase()).toContain('not');
  });
});

import { mergePolicy } from '../finance/financial-assumption-policy';

describe('PaymentService.estimateWithPolicy (single policy)', () => {
  const service = new PaymentService();

  it('never applies guessed tax/fees when dealer has not verified them', () => {
    const policy = mergePolicy({
      taxRatePercent: 9.25,
      taxBasis: 'price',
      docFee: 899,
    });
    expect(policy.mode).toBe('ILLUSTRATIVE');
    const est = service.estimateWithPolicy({ price: 30000, policy });
    expect(est.includesTaxAndFees).toBe(false);
    expect(est.breakdown.fees).toBe(0);
    expect(est.breakdown.taxAmount).toBe(0);
    expect(est.aprSource).toBe('ILLUSTRATIVE');
  });

  it('applies verified dealer tax/fees deterministically', () => {
    const policy = mergePolicy(
      { illustrativeApr: 6.9 },
      {
        taxRatePercent: 10,
        taxBasis: 'price',
        docFee: 300,
        verifiedAt: '2026-10-01T00:00:00Z',
      },
    );
    expect(policy.mode).toBe('DEALER_CONFIGURED');
    const est = service.estimateWithPolicy({
      price: 20000,
      policy,
      termMonths: 60,
    });
    expect(est.amountFinanced).toBe(20000 + 300 + 2000);
    expect(est.breakdown.apr).toBe(6.9);
  });

  it('distinguishes customer-supplied APR from illustrative APR', () => {
    const policy = mergePolicy({});
    const est = service.estimateWithPolicy({
      price: 20000,
      policy,
      customerApr: 4.5,
    });
    expect(est.aprSource).toBe('CUSTOMER');
    expect(est.breakdown.apr).toBe(4.5);
  });

  it('same inputs → identical numbers on every surface', () => {
    const policy = mergePolicy({ illustrativeApr: 7.9, defaultTermMonths: 72 });
    const a = service.estimateWithPolicy({
      price: 41995,
      policy,
      downPayment: 5000,
    });
    const b = service.estimateWithPolicy({
      price: 41995,
      policy,
      downPayment: 5000,
    });
    expect(a.monthlyPayment).toBe(b.monthlyPayment);
    expect(a.breakdown.termMonths).toBe(72);
  });
});
