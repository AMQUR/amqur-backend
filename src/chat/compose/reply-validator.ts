/**
 * Grounding validator for model-composed replies.
 *
 * The model may phrase, reorder, shorten, answer more directly, add general automotive
 * knowledge and handle small talk. It may NOT introduce dealership facts. Practical checks:
 *  1. complete output (no cut-off sentence, not empty, not absurdly long)
 *  2. every number it states (money, %, plain numbers, clock times) exists in an allowed
 *     source: the server draft, tool facts, the customer's own recent words, live-info data
 *  3. no commitment words ("confirmed", "booked", "approved", "notified", "reserved", "on
 *     hold", "guaranteed", "sold to you") unless the draft itself used them
 *  4. limiting words survive where the related claim is repeated: an appointment mentioned
 *     → "request"; a monthly amount → "estimate"; the credit app → "preview" when the draft
 *     said preview; an in-transit vehicle offered for a drive/pickup → "transit"
 *  5. no scores ("24-17") or forecasts presented as live unless live data was provided
 * Harmless wording changes never fail the check.
 */
export type ValidationResult = { ok: true } | { ok: false; reasons: string[] };

const NUM =
  /(?<![A-Za-z0-9])\$?\d[\d,]*(?:\.\d+)?%?(?![A-Za-z0-9])|\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b/gi;

export function numbersIn(text: string): string[] {
  return (text.match(NUM) ?? []).map((x) =>
    x
      .toLowerCase()
      .replace(/[$,\s]/g, '')
      .replace(/\.00$/, '')
      .replace(/%$/, ''),
  );
}

const COMMIT =
  /\b(confirmed|booked|approved|pre-?approved|notified|reserved|on hold|guaranteed|locked in|sold to you)\b/i;

export function validateComposedReply(params: {
  reply: string;
  draft: string;
  /** tool results / verified facts (strings) */
  facts: string[];
  /** the customer's recent messages (their own numbers are fine to repeat) */
  customerText: string[];
  /** live data shown to the model (weather periods etc.) */
  liveText?: string;
}): ValidationResult {
  const reasons: string[] = [];
  const r = params.reply.trim();
  const d = params.draft;
  if (!r) return { ok: false, reasons: ['empty'] };
  if (!/[.!?…)"”’]\s*$/.test(r)) reasons.push('truncated');
  // Concise customer replies: reject walls of text so the orchestrator falls
  // back to the (policy-tightened) server draft. Detailed asks can still pass
  // via a higher ceiling when the draft itself is long.
  const draftLen = d.trim().length;
  const maxLen = draftLen > 500 ? 900 : 480;
  if (r.length > maxLen) reasons.push('too_long');
  const qMarks = (r.replace(/https?:\/\/\S+/gi, '').match(/\?/g) ?? []).length;
  if (qMarks > 1) reasons.push('multiple_questions');
  const sentenceApprox = r
    .replace(/\b(U\.S|U\.K|Inc|Ltd|Dr|Mr|Mrs|Ms)\./gi, (m) =>
      m.replace(/\./g, ''),
    )
    .split(/(?<=[.!?…])\s+/)
    .filter((s) => s.trim()).length;
  if (draftLen <= 500 && sentenceApprox > 2) reasons.push('too_many_sentences');
  if (/\b(i'?d be more than happy|great question|absolutely[!])/i.test(r))
    reasons.push('banned_filler');

  const allowed = new Set(
    [d, ...params.facts, ...params.customerText, params.liveText ?? ''].flatMap(
      numbersIn,
    ),
  );
  const unsupported = numbersIn(r).filter((n) => !allowed.has(n));
  if (unsupported.length)
    reasons.push(`unsupported_numbers:${[...new Set(unsupported)].join(',')}`);

  const commit = COMMIT.exec(r);
  if (commit && !new RegExp(`\\b${commit[1]}\\b`, 'i').test(d))
    reasons.push(`commitment_word:${commit[1].toLowerCase()}`);

  const low = r.toLowerCase();
  const dl = d.toLowerCase();
  if (
    /\brequest/.test(dl) &&
    /\b(appointment|visit|test drive|service visit)\b/.test(low) &&
    !/\brequest/.test(low)
  )
    reasons.push('dropped_request_status');
  if (
    /\bestimate/.test(dl) &&
    /(\$[\d,]+\s*(?:a|per|\/)\s*mo|a month|per month)/.test(low) &&
    !/\bestimat/.test(low)
  )
    reasons.push('dropped_estimate_label');
  if (
    /\bpreview\b/.test(dl) &&
    /credit app/.test(low) &&
    !/\bpreview\b/.test(low)
  )
    reasons.push('dropped_preview_label');
  if (
    /in transit/.test(dl) &&
    /\b(test drive|drive it|take it home|pick it up|on the lot)\b/.test(low) &&
    !/transit|isn.t (?:here|on the lot)|not (?:here|on the lot)|arriv/.test(low)
  )
    reasons.push('dropped_in_transit');
  if (
    /\b\d{1,3}\s?-\s?\d{1,3}\b/.test(r) &&
    !params.liveText &&
    !/\b\d{1,3}\s?-\s?\d{1,3}\b/.test(d)
  )
    reasons.push('score_like_without_live_data');

  return reasons.length ? { ok: false, reasons } : { ok: true };
}
