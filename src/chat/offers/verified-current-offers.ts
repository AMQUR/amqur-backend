/**
 * Phase 1 rule: "current specials" may only cite explicitly approved,
 * currently valid, location-scoped OFFER spotlights with disclosures.
 *
 * Generic announcements and keyword-matched knowledge articles are NOT proof
 * of a current promotion.
 */

export type SpotlightLike = {
  kind?: unknown;
  title?: unknown;
  body?: unknown;
  disclaimer?: unknown;
  source?: unknown;
  endsAt?: unknown;
  id?: unknown;
};

export type VerifiedOfferLine = {
  id?: string;
  title: string;
  body: string;
  disclaimer: string;
  source?: string;
  endsAt?: string;
  line: string;
};

const OFFER_DISCLOSURE =
  'Offers are location-specific, may change without notice, and exclude taxes, fees, and lender approval where applicable. Ask the dealership to confirm current eligibility.';

export function offerDisclosure(): string {
  return OFFER_DISCLOSURE;
}

/** Keep only OFFER kind rows (never ANNOUNCEMENT / EVENT / VEHICLE as "specials"). */
export function selectVerifiedCurrentOffers(
  active: SpotlightLike[],
): VerifiedOfferLine[] {
  const out: VerifiedOfferLine[] = [];
  for (const o of active) {
    if (String(o.kind ?? '') !== 'OFFER') continue;
    const title = String(o.title ?? '').trim();
    const body = String(o.body ?? '').trim();
    const disclaimer = String(o.disclaimer ?? '').trim();
    // Offers require a disclaimer at create-time; refuse to surface without one.
    if (!disclaimer) continue;
    if (!title && !body) continue;
    const source = String(o.source ?? '').trim() || undefined;
    const endsAt =
      typeof o.endsAt === 'string'
        ? o.endsAt
        : o.endsAt instanceof Date
          ? o.endsAt.toISOString()
          : undefined;
    const line = `${title}${title && body ? ': ' : ''}${body} (${disclaimer})`;
    out.push({
      id: typeof o.id === 'string' ? o.id : undefined,
      title,
      body,
      disclaimer,
      source,
      endsAt,
      line,
    });
  }
  return out;
}
