import type { FinancialAssumptionPolicy } from './financial-assumption-policy';

/**
 * Out-the-door (OTD) estimate — SEPARATE from financing. Uses ONLY dealer-verified inputs:
 * the verified selling price, the dealer's verified tax rule, doc fee (not double-counted when
 * already in the advertised price, per FTC pricing guidance), other mandatory dealer fees and
 * government title/registration charges for the stated jurisdiction.
 *
 * If any required input is unverified the result is `computable: false` with the missing
 * inputs listed, and the caller routes a staff quote request instead of inventing a total.
 * Rebates/incentives/discounts are never applied (eligibility cannot be established in chat).
 * Even a computable result is a PRELIMINARY estimate, never a written dealer offer.
 */
export type OtdLine = {
  label: string;
  amount: number;
  kind: 'price' | 'dealer_fee' | 'tax' | 'government';
};

export type OtdEstimate =
  | {
      computable: true;
      lines: OtdLine[];
      total: number;
      assumptions: string[];
      jurisdiction: string;
      policyVersion: string;
    }
  | { computable: false; missingInputs: string[] };

const r2 = (n: number) => Math.round(n * 100) / 100;

export function estimateOutTheDoor(params: {
  price: number | null | undefined;
  policy: FinancialAssumptionPolicy;
  /** Customer's registration state if known; estimate is only valid for the policy jurisdiction. */
  customerState?: string | null;
}): OtdEstimate {
  const { policy: p } = params;
  const missing: string[] = [];
  if (!params.price || params.price <= 0) missing.push('verified_price');
  if (p.mode !== 'DEALER_CONFIGURED' || p.taxRatePercent === null)
    missing.push('tax_rate');
  if (p.docFee === null && !p.docFeeIncludedInPrice) missing.push('doc_fee');
  if (!p.governmentFees.length) missing.push('title_registration');
  if (!p.jurisdiction) missing.push('jurisdiction');
  if (
    params.customerState &&
    p.jurisdiction &&
    params.customerState.toUpperCase() !== p.jurisdiction
  )
    missing.push('out_of_state_registration');
  if (missing.length) return { computable: false, missingInputs: missing };

  const price = params.price!;
  const lines: OtdLine[] = [
    { label: 'Vehicle price', amount: r2(price), kind: 'price' },
  ];
  let dealerFees = 0;
  if (p.docFee !== null && !p.docFeeIncludedInPrice) {
    lines.push({
      label: 'Documentation fee',
      amount: r2(p.docFee),
      kind: 'dealer_fee',
    });
    dealerFees += p.docFee;
  }
  for (const f of p.otherFees) {
    lines.push({ label: f.label, amount: r2(f.amount), kind: 'dealer_fee' });
    dealerFees += f.amount;
  }
  // Tax basis "price" taxes the selling price plus taxable dealer fees; "net" would subtract a
  // verified trade value — never applied here because appraisals are not verified in chat.
  const taxable = price + dealerFees;
  const tax = r2((taxable * (p.taxRatePercent ?? 0)) / 100);
  lines.push({
    label: `Sales tax (${p.taxRatePercent}%)`,
    amount: tax,
    kind: 'tax',
  });
  for (const f of p.governmentFees)
    lines.push({ label: f.label, amount: r2(f.amount), kind: 'government' });
  const total = r2(lines.reduce((a, l) => a + l.amount, 0));
  const assumptions = [
    `Registration in ${p.jurisdiction}`,
    'No trade-in, rebates or incentives applied',
    'No optional add-ons',
  ];
  if (p.docFeeIncludedInPrice)
    assumptions.push(
      'Documentation fee is already included in the advertised price',
    );
  return {
    computable: true,
    lines,
    total,
    assumptions,
    jurisdiction: p.jurisdiction!,
    policyVersion: p.version,
  };
}
