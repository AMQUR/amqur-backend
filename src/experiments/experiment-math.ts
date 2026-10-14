import { createHash } from 'crypto';

export type Variant = { key: string; weight: number; text: string };

/** Stable assignment: same conversation + experiment → same variant, forever. */
export function assignVariant(
  conversationKey: string,
  experimentKey: string,
  variants: Variant[],
): Variant {
  const total = variants.reduce((a, v) => a + Math.max(0, v.weight), 0) || 1;
  const h = createHash('sha256')
    .update(`${experimentKey}:${conversationKey}`)
    .digest();
  const x = (h.readUInt32BE(0) / 0x1_0000_0000) * total;
  let acc = 0;
  for (const v of variants) {
    acc += Math.max(0, v.weight);
    if (x < acc) return v;
  }
  return variants[variants.length - 1];
}

/**
 * Two-proportion z-test of a variant's conversion vs the control. Returns null p-value when
 * either arm is below the minimum sample — the dashboard then says "insufficient data" instead
 * of implying a winner.
 */
export function compareRates(
  control: { n: number; conversions: number },
  variant: { n: number; conversions: number },
  minPerArm = 200,
) {
  const p1 = control.n ? control.conversions / control.n : 0;
  const p2 = variant.n ? variant.conversions / variant.n : 0;
  if (control.n < minPerArm || variant.n < minPerArm)
    return {
      controlRate: p1,
      variantRate: p2,
      lift: null,
      pValue: null,
      sufficient: false,
    };
  const p =
    (control.conversions + variant.conversions) / (control.n + variant.n);
  const se = Math.sqrt(p * (1 - p) * (1 / control.n + 1 / variant.n));
  const z = se > 0 ? (p2 - p1) / se : 0;
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));
  return {
    controlRate: p1,
    variantRate: p2,
    lift: p1 > 0 ? (p2 - p1) / p1 : null,
    pValue,
    sufficient: true,
  };
}

function normalCdf(z: number) {
  // Abramowitz–Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-z * z);
  return 0.5 * (1 + y);
}

const BANNED =
  /\$|\b(apr|approved|guarantee|only \d+ left|won'?t last|act (?:now|fast)|hurry|last chance|selling fast|free)\b/i;

/** Copy rules: greetings may differ in tone only — no prices, offers, urgency or promises. */
export function validateVariants(vs: unknown): Variant[] {
  if (!Array.isArray(vs) || vs.length < 2 || vs.length > 4)
    throw new Error('2–4 variants required');
  const out = vs.map((v) => {
    const o = v as Partial<Variant>;
    if (!o.key || !/^[a-z0-9-]{1,20}$/.test(o.key))
      throw new Error('variant key a-z0-9-');
    if (typeof o.text !== 'string' || !o.text.trim() || o.text.length > 200)
      throw new Error('text 1–200 chars');
    if (BANNED.test(o.text))
      throw new Error(
        `variant "${o.key}" contains a price, offer, approval or urgency wording`,
      );
    const w = Number(o.weight ?? 1);
    if (!(w > 0 && w <= 100)) throw new Error('weight 1–100');
    return { key: o.key, weight: w, text: o.text.trim() };
  });
  if (new Set(out.map((v) => v.key)).size !== out.length)
    throw new Error('duplicate keys');
  return out;
}
