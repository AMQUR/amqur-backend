import { containsPromptInjection } from '../../knowledge/prompt-injection.util';

/**
 * Deterministic reading of an inbound customer message. Runs BEFORE any model sees the text and
 * its results cannot be overridden by a model. CRM content is untrusted input.
 */
export type InboundSignal =
  | 'STOP'
  | 'UNSUBSCRIBE'
  | 'WRONG_NUMBER'
  | 'DO_NOT_CONTACT'
  | 'WANTS_HUMAN'
  | 'COMPLAINT'
  | 'LEGAL'
  | 'FINANCE_COMMITMENT'
  | 'NEGOTIATION'
  | 'SAFETY'
  | 'APPOINTMENT_CHANGE'
  | 'PURCHASE_INTENT'
  | 'SENSITIVE_DATA'
  | 'PROMPT_INJECTION'
  | 'HAS_LINK';

/** An opt-out keyword that leads the message, alone or with a short tail ("STOP please",
 *  "Stop. Thanks"). A sentence that merely contains the word ("can you stop by?",
 *  "cancel my appointment") is not a keyword opt-out — the phrase rules read those. */
const STOP_WORDS =
  /^\s*(stop|stopall|stop all|end|cancel|quit|revoke|unsubscribe|alto|parar|cancelar)\b[\s.!,]*(?:(?:please|pls|now|thanks|thank you|it|this|all|messages?|texts?|texting|por favor)[\s.!,]*){0,3}$/i;
/** Handset re-opt-in keywords. Only these re-open a channel after an opt-out in the history. */
const START_WORDS = /^\s*(start|unstop|subscribe)\s*[.!]*\s*$/i;

const RULES: Array<[InboundSignal, RegExp]> = [
  [
    'UNSUBSCRIBE',
    /\b(unsubscribe|opt(?:\s|-)?out|remove me|take me off|dar(?:me)? de baja)\b/i,
  ],
  [
    'DO_NOT_CONTACT',
    /\b(stop (?:texting|calling|emailing|contacting|messaging)|do(?:n'?t| not) (?:text|call|email|contact|message) me|leave me alone|no more (?:texts|calls|emails|messages)|quit (?:texting|calling)|no me (?:llamen|escriban|contacten)|dejen de (?:llamar|escribir))\b/i,
  ],
  [
    'WRONG_NUMBER',
    /\b(wrong (?:number|person)|you have the wrong|not (?:my|the right) (?:number|person)|who is this\?* i (?:never|didn'?t)|n[uú]mero equivocado)\b/i,
  ],
  [
    'WANTS_HUMAN',
    /\b(real person|a human|speak (?:to|with) (?:a |an |some)?(?:person|human|someone|manager|salesperson|sales ?man|agent|representative|rep|advisor)|talk (?:to|with) (?:a |an |some)?(?:person|human|someone|manager|salesperson|agent|representative|rep|advisor)|call me|have (?:someone|a salesperson|a manager) call|hablar con (?:una persona|alguien|un vendedor|un gerente))\b/i,
  ],
  [
    'COMPLAINT',
    /\b(complain|complaint|terrible|awful|worst|rip(?:ped)? ?off|scam|unacceptable|furious|disgusted|never (?:again|coming back)|bbb|better business bureau|bad review|report you|queja|estafa)\b/i,
  ],
  [
    'LEGAL',
    /\b(lawyer|attorney|lawsuit|sue|legal action|attorney general|lemon law|small claims|abogado|demanda)\b/i,
  ],
  [
    'FINANCE_COMMITMENT',
    /\b(am i approved|get (?:me )?approved|guarantee(?:d)? (?:approval|financing)|what(?:'s| is) (?:my|the) (?:apr|rate|interest)|credit score|bad credit|no credit|bankruptcy|repo(?:ssession)?|co-?sign|monthly payment (?:of|at|under)|aprobado|cr[eé]dito)\b/i,
  ],
  [
    'NEGOTIATION',
    /\b(best price|out the door|otd|lowest (?:price|you can)|beat (?:this|that|their) (?:price|offer|quote)|match (?:this|that|their)|discount|knock off|take \$?\d|will you do \$?\d|trade(?:-| )in (?:value|worth)|how much for my trade|mejor precio|descuento)\b/i,
  ],
  [
    'SAFETY',
    /\b(brakes? (?:failed|went out|not working|don'?t work)|smoke|smoking|fire|on fire|leaking (?:gas|fuel)|won'?t stop|steering (?:locked|failed)|airbag|accident|crash(?:ed)?|stalled on the (?:highway|road)|frenos)\b/i,
  ],
  [
    'APPOINTMENT_CHANGE',
    /\b(reschedul\w*|cancel (?:my|the|our) (?:appointment|appt)|can'?t make it|running late|move (?:my|the) (?:appointment|appt)|confirm(?:ing)? (?:my|the) (?:appointment|appt)|different (?:time|day)|reagendar|cancelar (?:mi|la) cita)\b/i,
  ],
  [
    'PURCHASE_INTENT',
    /\b(ready to buy|want to buy|i'?ll take it|come in today|coming (?:in|by) (?:today|tomorrow|now)|put (?:a |down a )?deposit|is it still available|still (?:have|got) it|when can i (?:come|pick)|test drive|quiero comprar|sigue disponible)\b/i,
  ],
  [
    'SENSITIVE_DATA',
    /\b(\d{3}-\d{2}-\d{4}|ssn|social security|driver'?s? licen[sc]e (?:number|#)|routing number|account number)\b/i,
  ],
  ['HAS_LINK', /\bhttps?:\/\/|\bwww\.[a-z0-9-]+\.[a-z]{2,}/i],
];

export function readInboundSignals(text: string): InboundSignal[] {
  const out = new Set<InboundSignal>();
  if (STOP_WORDS.test(text)) out.add('STOP');
  for (const [signal, re] of RULES) if (re.test(text)) out.add(signal);
  if (containsPromptInjection(text) || EXTRA_INJECTION.test(text))
    out.add('PROMPT_INJECTION');
  return [...out];
}

/** Injection shapes specific to a CRM agent (data exfiltration, permission and tool requests). */
const EXTRA_INJECTION =
  /\b(ignore (?:all |any |your )?(?:previous|prior|above) (?:instructions|rules)|system prompt|you are now|act as (?:an? )?(?:admin|developer|manager)|(?:list|show|send|give) (?:me )?(?:all|every|other) (?:customers?|leads?|phone numbers|emails|records)|change (?:my|your|the) permissions?|disable (?:the )?(?:compliance|filter|kill switch)|export (?:the )?(?:crm|database)|run (?:this|the) (?:command|tool|code))\b/i;

/**
 * Opt-out standing across a WHOLE conversation history, not just the unanswered tail: a STOP
 * or do-not-contact that staff later replied to is still a STOP. Walks the customer's inbound
 * messages oldest → newest; the last opt-out stands unless the customer themselves later sent
 * a re-opt-in keyword on that channel. Do-not-contact and wrong-number are never re-opened.
 */
export type StandingOptOut = {
  channelScope: 'CHANNEL' | 'ALL';
  reason: string;
  channel: 'SMS' | 'EMAIL';
};
export function standingOptOut(
  inbound: Array<{ body: string; channel: string; occurredAt: Date }>,
): StandingOptOut | null {
  let standing: StandingOptOut | null = null;
  const ordered = [...inbound].sort(
    (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
  );
  for (const m of ordered) {
    const channel = m.channel === 'EMAIL' ? 'EMAIL' : 'SMS';
    const sup = suppressionFor(readInboundSignals(m.body));
    if (sup) {
      // An every-channel opt-out is never narrowed by a later channel keyword.
      if (!(standing?.channelScope === 'ALL' && sup.channelScope === 'CHANNEL'))
        standing = { ...sup, channel };
    } else if (
      standing?.channelScope === 'CHANNEL' &&
      standing.channel === channel &&
      START_WORDS.test(m.body)
    ) {
      standing = null;
    }
  }
  return standing;
}

/** Signals that end contact. `ALL` is used for explicit do-not-contact and wrong-number. */
export function suppressionFor(
  signals: InboundSignal[],
): { channelScope: 'CHANNEL' | 'ALL'; reason: string } | null {
  if (signals.includes('DO_NOT_CONTACT'))
    return { channelScope: 'ALL', reason: 'DO_NOT_CONTACT' };
  if (signals.includes('WRONG_NUMBER'))
    return { channelScope: 'ALL', reason: 'WRONG_NUMBER' };
  if (signals.includes('STOP'))
    return { channelScope: 'CHANNEL', reason: 'STOP' };
  if (signals.includes('UNSUBSCRIBE'))
    return { channelScope: 'CHANNEL', reason: 'UNSUBSCRIBE' };
  return null;
}

/** Signals that must go to a person; the agent may not answer them on its own authority. */
export const ESCALATE_SIGNALS: readonly InboundSignal[] = [
  'WANTS_HUMAN',
  'COMPLAINT',
  'LEGAL',
  'FINANCE_COMMITMENT',
  'NEGOTIATION',
  'SAFETY',
  'SENSITIVE_DATA',
];

export function escalationFor(
  signals: InboundSignal[],
): { reason: InboundSignal; urgency: 'NORMAL' | 'HIGH' | 'CRITICAL' } | null {
  const hit = ESCALATE_SIGNALS.find((s) => signals.includes(s));
  if (!hit) return null;
  const urgency =
    hit === 'SAFETY' || hit === 'LEGAL'
      ? 'CRITICAL'
      : hit === 'COMPLAINT'
        ? 'HIGH'
        : 'NORMAL';
  return { reason: hit, urgency };
}
