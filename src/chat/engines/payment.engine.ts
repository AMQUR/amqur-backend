import { Injectable } from '@nestjs/common';

@Injectable()
export class PaymentEngine {
  calculateMonthlyPayment(input: {
    price: number;
    apr?: number;
    term?: number;
    taxRate?: number;
    docFee?: number;
    downPayment?: number;
  }): number {
    const {
      price,
      apr = 6.99,
      term = 72,
      taxRate = 0.095,
      docFee = 358,
      downPayment = 0,
    } = input;

    const taxableAmount = price + docFee - downPayment;

    const taxedTotal = taxableAmount * (1 + taxRate);

    const monthlyRate = apr / 100 / 12;

    const payment =
      (taxedTotal * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -term));

    return Math.round(payment);
  }
}
