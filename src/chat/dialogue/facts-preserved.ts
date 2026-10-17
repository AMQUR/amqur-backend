/**
 * A model rewrite of a server draft may change wording, never facts: every number, money
 * amount, percentage and clock time must match the draft exactly (none added, none dropped),
 * and status words that limit a claim ("request", "estimate", "not confirmed", "in transit")
 * must survive. Used for replies that also carry payment/appointment/OTD cards.
 */
const NUM = /\$?\d[\d,]*(?:\.\d+)?%?|\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b/gi;
const STATUS = [
  'request',
  'estimate',
  'not confirmed',
  'in transit',
  'preview',
  'not a',
  'example',
];

const nums = (s: string) =>
  (s.match(NUM) ?? [])
    .map((x) => x.toLowerCase().replace(/[,\s]/g, '').replace(/\.00$/, ''))
    .sort();

export function factsPreserved(draft: string, rewritten: string): boolean {
  const a = nums(draft);
  const b = nums(rewritten);
  if (a.length !== b.length || a.some((x, i) => x !== b[i])) return false;
  const d = draft.toLowerCase();
  const r = rewritten.toLowerCase();
  return STATUS.every((w) => !d.includes(w) || r.includes(w));
}
