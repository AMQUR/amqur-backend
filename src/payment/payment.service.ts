import { Injectable } from '@nestjs/common';

export type FinanceEstimateInput = {
  price: number; // vehicle price
  termMonths: number; // 24/36/48/60/72/84
  apr: number; // percent, ex: 7.99
  downPayment?: number; // dollars
  tradeIn?: number; // dollars
  fees?: number; // doc + title + reg + dealer fees
  taxRate?: number; // percent, ex: 9.25
  taxOn?: 'price' | 'net'; // price (simple) vs net (after down/trade)
};

export type FinanceEstimateOutput = {
  amountFinanced: number;
  monthlyPayment: number;
  totalPaid: number;
  totalInterest: number;
  breakdown: {
    price: number;
    downPayment: number;
    tradeIn: number;
    fees: number;
    taxRate: number;
    taxAmount: number;
    apr: number;
    termMonths: number;
  };
};

@Injectable()
export class PaymentService {
  /**
   * Educational defaults only — not dealership/lender offers.
   * Tenant-specific APR/fees/tax must come from verified config when available.
   */
  private DEFAULT_TERM = 72;
  private DEFAULT_APR = 9.99;
  private DEFAULT_FEES = 899;
  private DEFAULT_TAX_RATE = 9.25;
  private DEFAULT_TAX_ON: 'price' | 'net' = 'price';

  readonly estimateDisclaimer =
    'This is an educational payment estimate only, not a credit decision or official dealership offer. Actual APR, fees, taxes, and incentives must be verified with the dealership.';

  estimateFinance(input: FinanceEstimateInput): FinanceEstimateOutput {
    const price = this.money(input.price);

    const termMonths = this.clampInt(
      input.termMonths ?? this.DEFAULT_TERM,
      12,
      96,
    );
    const apr = this.clamp(input.apr ?? this.DEFAULT_APR, 0, 40);

    const downPayment = this.money(input.downPayment ?? 0);
    const tradeIn = this.money(input.tradeIn ?? 0);
    const fees = this.money(input.fees ?? this.DEFAULT_FEES);

    const taxRate = this.clamp(input.taxRate ?? this.DEFAULT_TAX_RATE, 0, 15);
    const taxOn = input.taxOn ?? this.DEFAULT_TAX_ON;

    const taxableBase =
      taxOn === 'net'
        ? Math.max(0, price - downPayment - tradeIn)
        : Math.max(0, price);

    const taxAmount = this.money((taxableBase * taxRate) / 100);

    // amount financed (simple model)
    const amountFinanced = this.money(
      Math.max(0, price - downPayment - tradeIn + fees + taxAmount),
    );

    const monthlyPayment = this.money(
      this.monthlyPayment(amountFinanced, apr, termMonths),
    );

    const totalPaid = this.money(monthlyPayment * termMonths);
    const totalInterest = this.money(Math.max(0, totalPaid - amountFinanced));

    return {
      amountFinanced,
      monthlyPayment,
      totalPaid,
      totalInterest,
      breakdown: {
        price,
        downPayment,
        tradeIn,
        fees,
        taxRate,
        taxAmount,
        apr,
        termMonths,
      },
    };
  }

  private monthlyPayment(
    principal: number,
    aprPercent: number,
    months: number,
  ): number {
    if (months <= 0) return 0;
    if (principal <= 0) return 0;

    const r = aprPercent / 100 / 12;

    // 0% APR
    if (r === 0) return principal / months;

    // standard amortization
    return (principal * r) / (1 - Math.pow(1 + r, -months));
  }

  private money(n: number): number {
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 100) / 100;
  }

  private clamp(n: number, min: number, max: number): number {
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  private clampInt(n: number, min: number, max: number): number {
    const x = Math.round(n);
    return this.clamp(x, min, max);
  }
}
