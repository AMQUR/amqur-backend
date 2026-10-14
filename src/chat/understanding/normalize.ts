/**
 * Customer-text normalization applied BEFORE intent rules (lowercase working copy only — the
 * original text is still used for names, VINs, emails and phone numbers).
 *
 *  - texting slang: "u", "r", "ur", "pls", "thx", "pmt", "w/" …
 *  - misspellings of intent keywords ("paymnet", "shedule", "aplication") via bounded edit
 *    distance against a small keyword vocabulary (never applied to short/common words)
 *  - voice-transcription splits of model names ("rang ler" → "wrangler",
 *    "grand wagon ear" → "grand wagoneer")
 *
 * Meaning-preserving only: it never invents quantities, vehicles or dates.
 */
const SLANG: Array<[RegExp, string]> = [
  [/\bu\b/g, 'you'],
  [/\bur\b/g, 'your'],
  [/\br\b(?=\s+(?:you|u|they|we|there|these|those)\b)/g, 'are'],
  [/\b(?:pls|plz|plez)\b/g, 'please'],
  [/\b(?:thx|thnx|tnx|ty)\b/g, 'thanks'],
  [/\b(?:pmt|pymt|pymnt)s?\b/g, 'payment'],
  [/\bw\/\s?/g, 'with '],
  [/\bmo\b(?=\s*(?:\?|$|payment))/g, 'month'],
  [/\bapt\b/g, 'appointment'],
  [/\bappt\b/g, 'appointment'],
  [/\binfo\b/g, 'information'],
  [/\bwanna\b/g, 'want to'],
  [/\bgonna\b/g, 'going to'],
  [/\bgotta\b/g, 'have to'],
  [/\bcuz\b/g, 'because'],
  [/\bidk\b/g, "i don't know"],
];

const VOICE: Array<[RegExp, string]> = [
  // spelled-out alphanumeric models: "q x 60" → "qx60", "q 50" → "q50", "rav 4" → "rav4"
  [/\bq ?x ?(\d{2})\b/g, 'qx$1'],
  [/\bq (\d{2})\b/g, 'q$1'],
  [/\brav ?4\b/g, 'rav4'],
  [/\brang(?:e)? ?ler\b/g, 'wrangler'],
  [/\bgrand wagon(?: |-)?ear\b/g, 'grand wagoneer'],
  [/\bwagon ?ear\b/g, 'wagoneer'],
  [/\bglad ?iator\b/g, 'gladiator'],
  [/\bcom ?pass\b(?= (?:suv|jeep|price|inventory|lease)|$)/g, 'compass'],
  [/\bout the door\b/g, 'out-the-door'],
  [/\bout of door\b/g, 'out-the-door'],
];

const KEYWORDS = [
  'payment',
  'payments',
  'monthly',
  'schedule',
  'appointment',
  'application',
  'financing',
  'finance',
  'service',
  'inventory',
  'compare',
  'available',
  'interested',
  'trade-in',
  'appraisal',
  'approved',
  'preapproved',
  'insurance',
  'warranty',
  'brakes',
  'transmission',
  'vehicle',
];

function dist(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = prev[0];
    prev[0] = i;
    let rowMin = prev[0];
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      // adjacent transposition ("paymnet")
      diag = tmp;
      rowMin = Math.min(rowMin, prev[j]);
    }
    if (rowMin > max) return max + 1;
  }
  return prev[b.length];
}

function fixWord(w: string): string {
  if (w.length < 6 || KEYWORDS.includes(w)) return w;
  // Real inflections ("approve", "scheduled", "vehicles") are words, not typos.
  if (KEYWORDS.some((k) => k.startsWith(w) || w.startsWith(k))) return w;
  // transposition check first (cheap, common)
  for (const k of KEYWORDS) {
    if (k.length !== w.length) continue;
    let diffs = 0;
    let at = -1;
    for (let i = 0; i < k.length; i += 1)
      if (k[i] !== w[i]) {
        diffs += 1;
        if (at < 0) at = i;
      }
    if (diffs === 2 && at >= 0 && w[at] === k[at + 1] && w[at + 1] === k[at])
      return k;
  }
  const max = w.length >= 9 ? 2 : 1;
  let best: string | null = null;
  let bestD = max + 1;
  for (const k of KEYWORDS) {
    const d = dist(w, k, max);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return best && bestD <= max ? best : w;
}

const SPOKEN: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  'twenty five': 25,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  uno: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  veinte: 20,
};
/** "five grand" → "5 grand", "two thousand" → "2 thousand", "cinco mil" → "5 mil". */
function spokenAmounts(t: string): string {
  return t.replace(
    /\b(twenty five|[a-z]+)\s+(grand|thousand|k|mil)\b/g,
    (m, w: string, unit: string) =>
      SPOKEN[w] !== undefined ? `${SPOKEN[w]} ${unit}` : m,
  );
}

export function normalizeCustomerText(lower: string): string {
  let t = spokenAmounts(lower);
  for (const [re, rep] of SLANG) t = t.replace(re, rep);
  for (const [re, rep] of VOICE) t = t.replace(re, rep);
  t = t.replace(/[a-z][a-z'-]{5,}/g, (w) => fixWord(w));
  return t;
}
