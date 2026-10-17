/**
 * Prompt-injection / pressure detection for customer turns.
 * Matches must refuse or fail closed — never obey override instructions.
 */

export type PressureKind =
  | 'system_prompt'
  | 'approval_claim'
  | 'price_override'
  | 'stock_override'
  | 'slot_override'
  | 'fitment_override'
  | 'internal_docs'
  | 'cross_tenant'
  | 'opt_out_override';

export const PRESSURE_PATTERNS: Array<{ kind: PressureKind; re: RegExp }> = [
  {
    kind: 'system_prompt',
    re: /\b(system prompt|your instructions|your rules|developer message|reveal (?:your|the) prompt|ignore (?:all(?:\s+previous)?|previous|your) (?:rules|instructions))\b/i,
  },
  {
    kind: 'approval_claim',
    re: /\b(already approved|manager (?:already )?approved|just confirm (?:it|my approval|i'?m approved)|say i'?m approved)\b/i,
  },
  {
    kind: 'price_override',
    re: /\b(tell me (?:this|the) (?:car|truck|vehicle) is \$?\d|say (?:the|it'?s|its) price is|price is \$?\d[\d,]* (?:now|instead)|honor (?:a |the )?price of)\b/i,
  },
  {
    kind: 'stock_override',
    re: /\b(database is wrong|say (?:it is|it'?s) in stock|just say (?:it'?s|it is) available)\b/i,
  },
  {
    kind: 'slot_override',
    re: /\b(even if there are no (?:slots|openings)|book (?:me|it) anyway|force (?:the|an) appointment)\b/i,
  },
  {
    kind: 'fitment_override',
    re: /\b(tell me (?:this|the|that) part (?:definitely )?fits|guarantee (?:it|the part) fits|definitely fits)\b/i,
  },
  {
    kind: 'internal_docs',
    re: /\b(internal (?:staff )?(?:doc|document|notes|policy)|staff[- ]only|confidential (?:doc|document))\b/i,
  },
  {
    kind: 'cross_tenant',
    re: /\b(another dealer'?s|other dealers?'? customers|show me (?:other )?customers|customer list|list of customers)\b/i,
  },
  {
    kind: 'opt_out_override',
    re: /\b(even though i opted out|ignore (?:my )?opt[- ]?out)\b/i,
  },
];

export function detectPressure(message: string): PressureKind | null {
  const hit = PRESSURE_PATTERNS.find((p) => p.re.test(message));
  return hit?.kind ?? null;
}
