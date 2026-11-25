import { Channel, VerifiedFact } from '../crm-workforce.types';

/**
 * Deterministic check of a model-written customer message. A draft that fails is never shown
 * as sendable: it is regenerated once, then escalated to a person.
 *
 * The guard cannot prove a sentence is true. It enforces the rule that claims of a regulated
 * kind (price, payment, rate, approval, availability, booking) may only appear when a verified,
 * fresh fact of that kind was supplied to the agent — otherwise the claim has no approved source.
 */
export type GuardViolation = { rule: string; detail?: string };

export type GuardInput = {
  text: string;
  channel: Channel;
  facts: VerifiedFact[];
  /** Earlier agent messages in this conversation (to stop repeated introductions). */
  priorAgentMessages: string[];
  agentDisplayName: string;
  /** True for the agent's first message to this customer: it must disclose it is virtual. */
  mustDisclose: boolean;
  /** A confirmed appointment from the CRM/scheduler exists for this lead. */
  appointmentConfirmed: boolean;
};

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/u;
const FILLER =
  /\b(i hope this (?:message|email) finds you well|great question|absolutely!|i'?d be (?:more than )?happy to|thank you for reaching out|as an ai|i understand your (?:concern|frustration) and|rest assured|don'?t hesitate to|at your earliest convenience|we value your business)\b/i;
const URGENCY =
  /\b(act now|today only|won'?t last|before it'?s gone|limited time|last chance|hurry|only \d+ left|going fast|expires (?:today|tonight)|don'?t miss out)\b/i;
const MONEY =
  /\$\s?\d|\b\d{1,3}(?:,\d{3})+\b(?!\s*(?:miles|mi\b))|\b\d+(?:\.\d+)?\s?%\s?(?:apr|interest|off)|\bapr\b/i;
const PAYMENT =
  /\b(?:per|a|\/)\s?(?:month|mo)\b|\bmonthly payment\b|\bdown payment\b|\b\d+\s?months?\b.*\bfinanc/i;
const APPROVAL =
  /\b(you(?:'re| are) (?:pre-?)?approved|guaranteed? (?:approval|financing|credit)|we can (?:get you|approve)|everyone is approved|no credit check)\b/i;
const TRADE_VALUE =
  /\b(?:trade(?:-| )in|your (?:car|vehicle|truck)) (?:is |will be )?worth\b|\bwe(?:'ll| will) give you\b/i;
const AVAILABILITY =
  /\b(is|it'?s|are|still|currently) (?:still )?(?:available|in stock|on the lot|here)\b|\bwe have (?:it|one|that|the)\b|\bjust (?:arrived|came in)\b/i;
const BOOKED =
  /\b(you(?:'re| are) (?:all )?(?:set|booked|confirmed|scheduled)|(?:i'?ve|i have|we'?ve|we have) (?:booked|scheduled|confirmed|reserved)|(?:appointment|appt) is (?:booked|confirmed|set)|see you (?:at|on|tomorrow|today))\b/i;
const DIAGNOSIS =
  /\b(it(?:'s| is) (?:probably|likely|definitely|just) (?:the|your|a)|sounds like (?:the|your|a)|(?:safe|fine|ok(?:ay)?) to (?:drive|keep driving)|nothing to worry about|will fit|guaranteed to fit|fits your)\b/i;
const HUMAN_CLAIM =
  /\b(i(?:'m| am) (?:a |the )?(?:real person|human|salesperson|sales manager|owner)|when i (?:drove|owned|bought)|my (?:wife|husband|kids|family|own car)|i personally)\b/i;
const LINK = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;
const VIRTUAL = /\b(virtual|ai|automated)\b/i;

export function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z¿¡"'(])/)
    .filter((s) => s.trim().length > 0);
}

export function guardDraft(i: GuardInput): GuardViolation[] {
  const v: GuardViolation[] = [];
  const t = i.text.trim();
  const add = (rule: string, detail?: string) => v.push({ rule, detail });
  const has = (kind: VerifiedFact['kind']) =>
    i.facts.some((f) => f.kind === kind && f.verified);

  if (!t) return [{ rule: 'empty' }];

  // Shape: short, plain, one question, no chatbot furniture.
  const n = sentences(t).length;
  if (i.channel === 'SMS') {
    if (n > 2) add('too_many_sentences', String(n));
    if (t.length > 320) add('too_long', String(t.length));
  } else {
    if (n > 6) add('too_many_sentences', String(n));
    if (t.length > 900) add('too_long', String(t.length));
  }
  if ((t.match(/\?/g) ?? []).length > 1) add('more_than_one_question');
  if (EMOJI.test(t)) add('emoji');
  if ((t.match(/!/g) ?? []).length > 1) add('excess_enthusiasm');
  if (/^\s*[-*•]\s|\n\s*\d+[.)]\s/m.test(t)) add('list_formatting');
  if (FILLER.test(t)) add('corporate_filler');
  if (URGENCY.test(t)) add('false_urgency');

  // Identity: never a human, never an invented personal experience; disclose when required.
  if (HUMAN_CLAIM.test(t)) add('impersonation');
  if (i.mustDisclose && !VIRTUAL.test(t)) add('missing_virtual_disclosure');
  const intro = new RegExp(
    `\\b(?:this is|i(?:'m| am)|my name is)\\s+${escapeRe(i.agentDisplayName)}\\b`,
    'i',
  );
  if (intro.test(t) && i.priorAgentMessages.some((m) => intro.test(m)))
    add('repeated_introduction');

  // Regulated claims need a verified source of the same kind.
  if ((MONEY.test(t) || PAYMENT.test(t)) && !has('offer') && !has('inventory'))
    add('unsourced_price_or_payment');
  if (APPROVAL.test(t)) add('credit_approval_promise');
  if (TRADE_VALUE.test(t)) add('trade_value_promise');
  if (AVAILABILITY.test(t) && !has('inventory')) add('unsourced_availability');
  if (BOOKED.test(t) && !i.appointmentConfirmed)
    add('unconfirmed_appointment_claim');
  if (DIAGNOSIS.test(t)) add('diagnosis_or_fitment_assurance');

  // Links: only ones that came from a verified fact.
  const allowed = i.facts
    .filter((f) => f.verified)
    .flatMap((f) => f.text.match(LINK) ?? []);
  for (const url of t.match(LINK) ?? [])
    if (!allowed.some((a) => stripUrl(a) === stripUrl(url)))
      add('unapproved_link', url);

  return v;
}

const stripUrl = (u: string) => u.replace(/[).,;!?]+$/, '').toLowerCase();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
