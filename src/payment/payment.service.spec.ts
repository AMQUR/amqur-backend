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
