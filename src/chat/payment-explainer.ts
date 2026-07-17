import { Injectable } from '@nestjs/common';

@Injectable()
export class PaymentExplainer {
  explain(params: {
    price: number;
    estimatedPayment: number;
    downPayment?: number;
    apr?: number;
    termMonths?: number;
  }): string {
    const term = params.termMonths ?? 72;
    const apr = params.apr ?? 6.9;
    const down = params.downPayment ?? 0;

    const parts: string[] = [];

    parts.push(
      `This estimate is based on a ${term}-month loan at about ${apr}% APR.`,
    );

    if (down > 0) {
      parts.push(`It assumes roughly $${down.toLocaleString()} down.`);
    } else {
      parts.push(`No down payment was included.`);
    }

    parts.push(
      `That puts the payment around $${params.estimatedPayment}/month before taxes and fees.`,
    );

    parts.push(
      `Lowering the term, increasing the down payment, or qualifying for a lower APR would reduce the monthly payment.`,
    );

    return parts.join(' ');
  }
}
