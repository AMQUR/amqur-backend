/**
 * Customer-reported incidents at the dealership.
 *
 * These are allegations, not findings. Severity decides the reply:
 * dissatisfaction (rude treatment), allegation (yelling, theft), danger (assault).
 * A later turn can add a name or say the person is safe without opening a new case.
 */

export type IncidentSeverity = 'dissatisfaction' | 'allegation' | 'danger';

export type CustomerIncident = {
  severity: IncidentSeverity;
  /** Name the customer gave. Unverified. */
  reportedName?: string;
  /** They say the immediate danger has passed. */
  safeNow?: boolean;
  /** They are inside the store, correcting a suggestion to go to a car. */
  insideDealership?: boolean;
  /** A detail added to an open report, not a new incident. */
  continuing?: boolean;
};

const DANGER =
  /\b(?:tried to|try to|going to|gonna|threatened to)\s+(?:hit|punch|attack|hurt|kill)\b|\b(?:he|she|they|someone|the manager|steve)\s+(?:hit|punched|attacked|grabbed|choked)\s+me\b|\b(?:assault|assaulted|pulled a (?:gun|knife)|has a (?:gun|knife|weapon))\b|\bhit me\b(?!\s+(?:up|with|back))/;

const ALLEGATION =
  /\b(?:yelled|screamed|shouted|cursed|swore|harass\w*|threatened|steal|stole|stolen|theft|robbed|racist|discriminat\w*|groped|touched me)\b/;

const DISSATISFACTION =
  /\b(?:mean to me|was mean to me|were mean to me|rude to me|disrespect\w*|treated me (?:badly|poorly|like)|terrible (?:service|experience)|awful (?:service|experience)|worst (?:experience|service)|so rude|was rude|were rude)\b/;

const NAME =
  /\b(?:his|her|their|(?:the )?(?:manager|employee|salesperson|salesman|guy|person)(?:'s)?)\s+name\s+(?:is|was)\s+([a-z][a-z'-]{1,30})\b|\bnamed\s+([a-z][a-z'-]{1,30})\b/i;

const SAFE =
  /\b(?:no[, ]+)?(?:i(?:'m| am)|im|we(?:'re| are))\s+(?:ok|okay|fine|safe|alright|good)\b|\bi(?:'m| am) safe now\b|\bno (?:i(?:'m| am) )?(?:not in danger)\b/;

const INSIDE =
  /\b(?:i(?:'m| am)|im|we(?:'re| are))\s+(?:not\s+)?(?:inside|in)\s+the\s+(?:dealership|store|showroom|building)\b|\bno i(?:'m| am)? not\b.*\binside\b/;

const NAME_STOP = new Set([
  'the',
  'a',
  'an',
  'manager',
  'employee',
  'guy',
  'person',
  'someone',
  'him',
  'her',
  'them',
  'there',
  'here',
  'mean',
  'rude',
]);

function capName(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

export function incidentRank(s: IncidentSeverity): number {
  return s === 'danger' ? 3 : s === 'allegation' ? 2 : 1;
}

export function classifyCustomerIncident(
  message: string,
  opts?: { incidentActive?: boolean; incidentSeverity?: IncidentSeverity },
): CustomerIncident | null {
  const t = ` ${message.toLowerCase().replace(/[’]/g, "'")} `;
  const name = NAME.exec(message);
  const reportedName = name
    ? capName((name[1] ?? name[2] ?? '').trim())
    : undefined;
  const usableName =
    reportedName && !NAME_STOP.has(reportedName.toLowerCase())
      ? reportedName
      : undefined;
  const danger = DANGER.test(t);
  const allegation = ALLEGATION.test(t);
  const dissatisfaction = DISSATISFACTION.test(t);
  const safeNow = SAFE.test(t);
  const inside = INSIDE.test(t);

  if (
    !opts?.incidentActive &&
    safeNow &&
    !danger &&
    !allegation &&
    !dissatisfaction
  )
    return null;

  let severity: IncidentSeverity | undefined;
  if (danger) severity = 'danger';
  else if (allegation) severity = 'allegation';
  else if (dissatisfaction) severity = 'dissatisfaction';
  else if (opts?.incidentActive && (usableName || safeNow || inside))
    severity = opts.incidentSeverity ?? 'dissatisfaction';

  if (!severity) return null;

  // "I'm okay" must not be re-read as a fresh complaint.
  if (safeNow && !danger && !allegation && !dissatisfaction) {
    return {
      severity: opts?.incidentSeverity ?? severity,
      safeNow: true,
      reportedName: usableName,
      insideDealership: inside || undefined,
      continuing: true,
    };
  }

  return {
    severity,
    reportedName: usableName,
    safeNow: safeNow || undefined,
    insideDealership: inside || undefined,
    continuing: Boolean(
      opts?.incidentActive && !danger && !allegation && !dissatisfaction,
    ),
  };
}
