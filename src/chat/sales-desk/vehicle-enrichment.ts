import type { FinancialAssumptionPolicy } from '../../finance/financial-assumption-policy';

/**
 * Whether the listed price already includes dealer-required fees — answered ONLY from the
 * dealer-configured pricing policy. Unknown stays null; it is never inferred.
 *   true  — the policy says the documentation fee is in the advertised price and lists no
 *           other dealer fee
 *   false — the policy lists a dealer fee that is added on top of the price
 *   null  — no dealer-verified policy, or the policy does not say
 */
export function priceIncludesDealerFees(
  policy: Pick<
    FinancialAssumptionPolicy,
    'mode' | 'docFee' | 'docFeeIncludedInPrice' | 'otherFees'
  > | null,
): boolean | null {
  if (!policy || policy.mode !== 'DEALER_CONFIGURED') return null;
  const extra = policy.otherFees.length > 0;
  if (extra) return false;
  if (policy.docFeeIncludedInPrice) return true;
  if (policy.docFee !== null && policy.docFee > 0) return false;
  return null;
}

/**
 * A vehicle's own listing page. Returned only when the feed record carries an https URL whose
 * host is the owning rooftop's verified website host (or a subdomain of it). Never built from
 * a pattern, a VIN or a stock number.
 */
export function verifiedVdpUrl(
  rawSource: unknown,
  rooftopWebsiteUrl: string | null | undefined,
): string | null {
  if (!rawSource || typeof rawSource !== 'object' || Array.isArray(rawSource))
    return null;
  const r = rawSource as Record<string, unknown>;
  const candidate = [r.vdpUrl, r.vdp_url, r.detailUrl, r.detail_url].find(
    (x): x is string => typeof x === 'string' && x.trim().length > 0,
  );
  if (!candidate || !rooftopWebsiteUrl) return null;
  let url: URL;
  let site: URL;
  try {
    url = new URL(candidate.trim());
    site = new URL(rooftopWebsiteUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || site.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  const siteHost = site.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== siteHost && !host.endsWith(`.${siteHost}`)) return null;
  return url.toString();
}
