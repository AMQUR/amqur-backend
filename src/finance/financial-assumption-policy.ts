import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * ONE authoritative per-tenant/per-location payment-assumption policy. Every surface
 * (carousel, payment card, chat estimate, comparison, staff UI, public API) must call
 * `resolve()` and pass the result to PaymentService — no component may carry its own
 * hidden APR/term/tax/fee defaults.
 *
 * When the dealer has not configured authoritative tax/fee rules the estimate is labeled
 * ILLUSTRATIVE and excludes taxes/fees (never guessed). An illustrative APR is shown as
 * such — it is never a dealer or lender offer.
 */
export type FinancialAssumptionPolicy = {
  version: string;
  /** ILLUSTRATIVE = no dealer-verified tax/fee rules; DEALER_CONFIGURED = tax+fees verified by staff */
  mode: 'ILLUSTRATIVE' | 'DEALER_CONFIGURED';
  defaultTermMonths: number;
  allowedTerms: number[];
  /** Illustration rate shown when customer did not supply one. Labeled "illustrative". */
  illustrativeApr: number;
  /** Only when mode=DEALER_CONFIGURED */
  taxRatePercent: number | null;
  taxBasis: 'price' | 'net' | null;
  docFee: number | null;
  otherFees: Array<{ label: string; amount: number }>;
  verifiedAt: string | null;
  verifiedBy: string | null;
  disclaimer: string;
};

export type AprSource = 'CUSTOMER' | 'ILLUSTRATIVE' | 'VERIFIED_OFFER';

export const SYSTEM_DEFAULT_POLICY: FinancialAssumptionPolicy = {
  version: 'system-default-v1',
  mode: 'ILLUSTRATIVE',
  defaultTermMonths: 72,
  allowedTerms: [24, 36, 48, 60, 72, 84],
  illustrativeApr: 7.9,
  taxRatePercent: null,
  taxBasis: null,
  docFee: null,
  otherFees: [],
  verifiedAt: null,
  verifiedBy: null,
  disclaimer:
    'Illustrative estimate only — not a credit decision or dealership offer. Excludes taxes and fees unless shown. The rate shown is an example, not your rate. The dealership can confirm exact figures.',
};

function num(v: unknown, min: number, max: number): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

export function mergePolicy(
  ...layers: Array<unknown>
): FinancialAssumptionPolicy {
  const out: FinancialAssumptionPolicy = {
    ...SYSTEM_DEFAULT_POLICY,
    otherFees: [],
  };
  for (const raw of layers) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const l = raw as Record<string, unknown>;
    const term = num(l.defaultTermMonths, 12, 96);
    if (term) out.defaultTermMonths = Math.round(term);
    if (Array.isArray(l.allowedTerms)) {
      const terms = l.allowedTerms
        .map((t) => num(t, 12, 96))
        .filter((t): t is number => t !== null)
        .map(Math.round);
      if (terms.length)
        out.allowedTerms = [...new Set(terms)].sort((a, b) => a - b);
    }
    const apr = num(l.illustrativeApr, 0, 30);
    if (apr !== null) out.illustrativeApr = apr;
    const tax = num(l.taxRatePercent, 0, 15);
    if (tax !== null) out.taxRatePercent = tax;
    if (l.taxBasis === 'price' || l.taxBasis === 'net')
      out.taxBasis = l.taxBasis;
    const doc = num(l.docFee, 0, 5000);
    if (doc !== null) out.docFee = doc;
    if (Array.isArray(l.otherFees)) {
      out.otherFees = l.otherFees
        .filter(
          (f): f is { label: string; amount: number } =>
            !!f &&
            typeof (f as { label?: unknown }).label === 'string' &&
            num((f as { amount?: unknown }).amount, 0, 10000) !== null,
        )
        .map((f) => ({
          label: f.label.slice(0, 60),
          amount: Number(f.amount),
        }));
    }
    if (typeof l.verifiedAt === 'string') out.verifiedAt = l.verifiedAt;
    if (typeof l.verifiedBy === 'string') out.verifiedBy = l.verifiedBy;
    if (typeof l.version === 'string') out.version = l.version.slice(0, 60);
    if (typeof l.disclaimer === 'string' && l.disclaimer.trim()) {
      out.disclaimer = l.disclaimer.trim().slice(0, 500);
    }
  }
  // Tax/fee rules are only "dealer configured" when staff verified them; otherwise strip them
  // so no estimate silently includes guessed fees.
  const dealerConfigured =
    !!out.verifiedAt && out.taxRatePercent !== null && out.taxBasis !== null;
  if (dealerConfigured) {
    out.mode = 'DEALER_CONFIGURED';
  } else {
    out.mode = 'ILLUSTRATIVE';
    out.taxRatePercent = null;
    out.taxBasis = null;
    out.docFee = null;
    out.otherFees = [];
  }
  if (!out.allowedTerms.includes(out.defaultTermMonths)) {
    out.allowedTerms = [...out.allowedTerms, out.defaultTermMonths].sort(
      (a, b) => a - b,
    );
  }
  return out;
}

@Injectable()
export class FinancialAssumptionPolicyService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(
    tenantId: string,
    locationId?: string | null,
  ): Promise<FinancialAssumptionPolicy> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { financialPolicy: true },
    });
    const loc = locationId
      ? await this.prisma.location.findFirst({
          where: { id: locationId, tenantId },
          select: { financialPolicy: true },
        })
      : null;
    return mergePolicy(tenant?.financialPolicy, loc?.financialPolicy);
  }
}
