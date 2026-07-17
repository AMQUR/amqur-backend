import { PaymentPreferences } from './payment/payment.types';
export class PaymentExtractor {
  static extract(message: string) {
    const msg = message.toLowerCase();

    const monthlyMatch = msg.match(
      /\b(under|below|less than|<=?)\s*\$?\s*(\d{2,4})\s*(\/?\s*mo(nth)?|a\s*month|monthly)?\b/,
    );

    const maxMonthlyPayment = monthlyMatch
      ? Number(monthlyMatch[2])
      : undefined;

    let termMonths: number | undefined;
    const termMatch = msg.match(/\b(36|48|60|72|84)\s*(months|mos|mo)\b/);
    if (termMatch) termMonths = Number(termMatch[1]);

    const yearsMatch = msg.match(/\b([3-7])\s*year\b/);
    if (!termMonths && yearsMatch) termMonths = Number(yearsMatch[1]) * 12;

    let downPayment: number | undefined;
    const downMatch = msg.match(
      /\b(\$?\s*\d{2,6})(k)?\s*(down|downpayment|down payment)\b/,
    );

    if (downMatch) {
      const raw = Number(downMatch[1].replace(/\$/g, '').trim());
      downPayment = downMatch[2] ? raw * 1000 : raw;
    }

    let apr: number | undefined;
    const aprMatch = msg.match(/\b(apr\s*)?(\d{1,2}(\.\d)?)\s*(%|percent)\b/);

    if (aprMatch && msg.includes('apr')) {
      apr = Number(aprMatch[2]);
    }

    if (!apr) {
      const pct = msg.match(/\b(\d{1,2}(\.\d)?)\s*(%|percent)\b/);

      if (pct && /payment|monthly|loan|finance|term/.test(msg)) {
        apr = Number(pct[1]);
      }
    }

    return {
      maxMonthlyPayment,
      termMonths,
      downPayment,
      apr,
      tradeIn: undefined,
    };
  }
}
