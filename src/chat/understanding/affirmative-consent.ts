/**
 * Affirmative / acknowledgment helpers.
 *
 * Typo acknowledgments ("oAY", "OKy") normalize to ok/okay for conversational
 * continuity, but must NEVER authorize SMS consent, credit actions, external
 * communications, or other consequential writes. Those require an explicit
 * consent phrase on a fresh ask.
 */

/** Whole-message typo ack tokens (pre-normalization raw customer text). */
const TYPO_ACK = /^\s*(?:oay|oky|okey)\s*[.!]?\s*$/i;

/** Explicit consent for consequential actions — stronger than bare ok/sure. */
const EXPLICIT_CONSEQUENTIAL_CONSENT =
  /^\s*(?:yes(?:\s+(?:please|i\s+(?:do|agree|consent)))?|yeah|yep|yup|please(?:\s+do)?|do\s+it|go\s+ahead|i\s+(?:agree|consent)|i(?:'d|\s+would)\s+like\s+(?:that|to)|sounds\s+good|let'?s\s+do\s+it|s[ií]|claro|dale)(?:[,\s].*)?[.!]?\s*$/i;

/** Pending questions that write consent / credit / external escalation. */
export const CONSEQUENTIAL_PENDING = new Set([
  'text_consent',
  'confirm_credit_link',
  'confirm_handoff',
]);

/** Offer kinds that must not be accepted via typo ack alone. */
export const CONSEQUENTIAL_OFFER_KINDS = new Set([
  'credit',
  'handoff',
  'visit',
  'service',
]);

export function isTypoAcknowledgment(raw: string): boolean {
  return TYPO_ACK.test((raw ?? '').trim());
}

/**
 * True when the customer explicitly consented in this message.
 * Bare "ok" / "okay" / "sure" / typo acks are insufficient.
 */
export function isExplicitConsequentialConsent(raw: string): boolean {
  const t = (raw ?? '').trim();
  if (!t || isTypoAcknowledgment(t)) return false;
  if (/^\s*(?:ok|okay|sure)\s*[.!]?\s*$/i.test(t)) return false;
  return EXPLICIT_CONSEQUENTIAL_CONSENT.test(t);
}

export function blocksConsequentialAffirm(
  raw: string,
  pending: string | null | undefined,
  offerKind?: string | null,
): boolean {
  const consequentialPending = !!pending && CONSEQUENTIAL_PENDING.has(pending);
  const consequentialOffer =
    !!offerKind && CONSEQUENTIAL_OFFER_KINDS.has(offerKind);
  if (!consequentialPending && !consequentialOffer) return false;
  return !isExplicitConsequentialConsent(raw);
}
