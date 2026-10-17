/**
 * Conversation Intelligence: short, natural, truthful customer-facing replies.
 *
 * Policy decides facts/actions via ResponsePlan; this module enforces brevity,
 * one-question discipline, and telemetry. It does NOT invent dealership facts.
 *
 * Precedence (documented in docs/ai/HUMAN_CONVERSATION_POLICY.md):
 * 1. Safety / compliance / truth
 * 2. Answer the actual question
 * 3. Single most useful next action
 * 4. Default 1–2 natural sentences
 * 5. At most one question per ordinary turn
 */

import type { ResponsePlan } from './dialogue-style';

export const CONVERSATION_POLICY_VERSION = 'conv-policy-v1-2026-10';

/** Pending keys that mean the service appointment flow is moving forward. */
const SERVICE_SCHEDULING_PENDING = new Set([
  'service_vehicle',
  'service_need',
  'appointment_date',
  'appointment_time',
]);

export function isServiceSchedulingPending(key: string): boolean {
  return SERVICE_SCHEDULING_PENDING.has(key);
}

/** Matches simulator `task_service` progress (question or scheduling language). */
export function replyShowsServiceSchedulingProgress(text: string): boolean {
  return /vehicle|what day|what time|need|when|veh[ií]culo|d[ií]a|hora|necesita/i.test(
    text,
  );
}

/** Re-attach a service scheduling question if length/compose dropped it. */
export function ensureServiceSchedulingFollowUp(params: {
  reply: string;
  followUpText?: string;
  pendingKey?: string;
}): string {
  if (!params.followUpText?.trim()) return params.reply;
  if (!isServiceSchedulingPending(params.pendingKey ?? '')) return params.reply;
  if (replyShowsServiceSchedulingProgress(params.reply)) return params.reply;
  const q = params.followUpText.trim();
  if (params.reply.includes(q)) return params.reply;
  return `${params.reply.trim()} ${q}`.replace(/\s+/g, ' ').trim();
}

/** Per-turn verbosity modes. `detailed` is an explicit exception path. */
export type VerbosityMode =
  | 'concise' // default: 1–2 sentences
  | 'detailed' // customer asked for detail / regulatory / comparison
  | 'regulatory' // disclosures must stay intact
  | 'verbose'; // tenant opted into longer format (feature flag)

export type ResponseTurnKind =
  | 'simple_answer'
  | 'inventory_result'
  | 'appointment'
  | 'trade'
  | 'finance_education'
  | 'service'
  | 'parts'
  | 'objection'
  | 'complaint'
  | 'human_handoff'
  | 'small_talk'
  | 'marketing_follow_up'
  | 'regulatory_notice'
  | 'requested_detailed_answer';

export type ConversationStage =
  | 'GREETING'
  | 'DISCOVER_INTENT'
  | 'ANSWER_QUESTION'
  | 'INVENTORY_SEARCH'
  | 'TRADE_DISCOVERY'
  | 'FINANCE_EDUCATION'
  | 'SERVICE_TRIAGE'
  | 'PARTS_LOOKUP'
  | 'APPOINTMENT_INTENT'
  | 'SUPPORT'
  | 'NEXT_BEST_ACTION'
  | 'HANDOFF'
  | 'FOLLOW_UP'
  | 'OUTCOME';

export type LengthBudget = {
  /** Soft target words for ordinary turns */
  targetWordsMin: number;
  targetWordsMax: number;
  /** Hard character ceiling before fallback / reject (not mid-sentence truncate) */
  maxChars: number;
  /** Max sentences before we prefer regenerating / falling back to draft */
  maxSentences: number;
};

export type LengthEval = {
  words: number;
  sentences: number;
  questions: number;
  chars: number;
  withinBudget: boolean;
  justifiedExtraLength: boolean;
  warnings: string[];
};

export type PlannedCustomerReply = {
  plan: ResponsePlan;
  verbosityMode: VerbosityMode;
  turnKind: ResponseTurnKind;
  policyVersion: string;
  length: LengthEval;
  droppedNarration: number;
  droppedAnswers: number;
};

const DETAILED_HINT =
  /\b(tell me (?:all|more|everything)|all the (?:features|details|specs)|full (?:breakdown|list|details)|compare|comparison|side[- ]by[- ]side|pros and cons|explain (?:in detail|how|why)|walk me through|disclaimer|disclosure|legal|warranty terms|fine print)\b/i;

const REGULATORY_HINT =
  /\b(apr|interest rate|finance charge|tcpa|consent|privacy|credit (?:score|application)|equal credit|ofac)\b/i;

/** Customer closing / thanks — aligned with orchestrator natural pacing in `finish()`. */
export const CUSTOMER_FAREWELL_RE =
  /\b(thanks?|thank you|bye|goodbye|that'?s all|i'?m (?:all )?good|all set)\b/i;

export function isCustomerFarewellMessage(message: string): boolean {
  return CUSTOMER_FAREWELL_RE.test(message);
}

/**
 * Whether the orchestrator should skip asking a ranked follow-up this turn.
 * After substantive answers: always suppress on customer farewell; otherwise
 * suppress only soft discovery prompts (`key === 'none'`, priority > 5).
 */
export function shouldSuppressRankedFollowUp(p: {
  customerMessage: string;
  hasSubstantiveAnswers: boolean;
  questionPriority: number;
  questionKey: string;
  forcedReply?: boolean;
}): boolean {
  if (p.forcedReply || !p.hasSubstantiveAnswers) return false;
  if (isCustomerFarewellMessage(p.customerMessage)) return true;
  return p.questionPriority > 5 && p.questionKey === 'none';
}

/** Rough word count that tolerates URLs, MSRP, APR, model names, decimals. */
export function estimateWords(text: string): number {
  const t = text.trim();
  if (!t) return 0;
  // Collapse URLs and VINs to single tokens so they don't inflate word counts.
  const normalized = t
    .replace(/https?:\/\/\S+/gi, 'URL')
    .replace(/\b[A-HJ-NPR-Z0-9]{17}\b/g, 'VIN')
    .replace(/\$[\d,]+(?:\.\d{2})?/g, 'PRICE')
    .replace(/\b\d+(?:\.\d+)?%\b/g, 'PCT');
  return normalized.split(/\s+/).filter(Boolean).length;
}

/** Sentence split that keeps abbreviations (U.S., Dr., Inc.) from false splits. */
export function splitSentences(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  const protected_ = t
    .replace(/\b(U\.S|U\.K|Inc|Ltd|Corp|Jr|Sr|Dr|Mr|Mrs|Ms)\./gi, (m) =>
      m.replace(/\./g, '∯'),
    )
    .replace(/(\d)\.(\d)/g, '$1∯$2');
  return protected_
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.replace(/∯/g, '.').trim())
    .filter(Boolean);
}

export function countQuestions(text: string): number {
  // Count question marks that look like real questions (ignore URLs).
  const withoutUrls = text.replace(/https?:\/\/\S+/gi, '');
  return (withoutUrls.match(/\?/g) ?? []).length;
}

export type CustomerChannel = 'WIDGET' | 'SMS' | 'EMAIL' | 'WHATSAPP' | 'VOICE';

export function budgetFor(
  mode: VerbosityMode,
  channel?: CustomerChannel | null,
): LengthBudget {
  const smsTight =
    channel === 'SMS'
      ? {
          targetWordsMin: 6,
          targetWordsMax: 40,
          maxChars: 320,
          maxSentences: 2,
        }
      : null;
  switch (mode) {
    case 'detailed':
    case 'regulatory':
      return {
        targetWordsMin: 20,
        targetWordsMax: 120,
        maxChars: channel === 'SMS' ? 480 : 900,
        maxSentences: channel === 'SMS' ? 4 : 6,
      };
    case 'verbose':
      return {
        targetWordsMin: 15,
        targetWordsMax: 90,
        maxChars: channel === 'SMS' ? 480 : 1100,
        maxSentences: channel === 'SMS' ? 4 : 5,
      };
    case 'concise':
    default:
      return (
        smsTight ?? {
          targetWordsMin: 8,
          targetWordsMax: 45,
          maxChars: 420,
          maxSentences: 2,
        }
      );
  }
}

/**
 * Explicit turn pacing. Orchestrator handlers still produce content;
 * policy uses this to drop follow-ups on wait/escalate turns.
 */
export type TurnMode = 'answer' | 'ask' | 'wait' | 'escalate' | 'end';

export function decideTurnMode(p: {
  aiPaused?: boolean;
  handoffOpen?: boolean;
  hasAnswers?: boolean;
  hasQuestion?: boolean;
  customerFarewell?: boolean;
  missingCritical?: boolean;
}): TurnMode {
  if (p.aiPaused) return 'wait';
  if (p.handoffOpen) return 'escalate';
  if (p.customerFarewell && !p.hasAnswers) return 'end';
  if (p.hasAnswers && p.hasQuestion) return 'ask';
  if (p.hasAnswers) return 'answer';
  if (p.missingCritical || p.hasQuestion) return 'ask';
  return 'answer';
}

export function resolveVerbosityMode(params: {
  customerMessage: string;
  verboseRepliesFlag?: boolean;
  forcedDetailed?: boolean;
  turnKind?: ResponseTurnKind;
}): VerbosityMode {
  if (params.verboseRepliesFlag) return 'verbose';
  if (params.forcedDetailed) return 'detailed';
  if (params.turnKind === 'regulatory_notice') return 'regulatory';
  if (params.turnKind === 'requested_detailed_answer') return 'detailed';
  if (DETAILED_HINT.test(params.customerMessage)) return 'detailed';
  if (
    REGULATORY_HINT.test(params.customerMessage) &&
    DETAILED_HINT.test(params.customerMessage)
  )
    return 'regulatory';
  return 'concise';
}

export function inferTurnKind(params: {
  intents?: string[];
  hasCards?: boolean;
  sentiment?: string;
  socialOnly?: boolean;
}): ResponseTurnKind {
  const intents = params.intents ?? [];
  if (params.sentiment === 'frustrated') return 'complaint';
  if (intents.includes('HUMAN_HANDOFF') || intents.includes('REQUEST_HUMAN'))
    return 'human_handoff';
  if (intents.some((i) => /APPOINTMENT|SCHEDULE|TEST_DRIVE/.test(i)))
    return 'appointment';
  if (intents.some((i) => /TRADE/.test(i))) return 'trade';
  if (intents.some((i) => /FINANCE|PAYMENT|CREDIT|APR|LEASE/.test(i)))
    return 'finance_education';
  if (intents.some((i) => /SERVICE/.test(i))) return 'service';
  if (intents.some((i) => /PARTS/.test(i))) return 'parts';
  if (
    params.hasCards ||
    intents.some((i) => /INVENTORY|VEHICLE|SEARCH/.test(i))
  )
    return 'inventory_result';
  if (params.socialOnly) return 'small_talk';
  return 'simple_answer';
}

export function evaluateLength(
  text: string,
  mode: VerbosityMode,
  opts?: { justifiedExtraLength?: boolean; channel?: CustomerChannel | null },
): LengthEval {
  const budget = budgetFor(mode, opts?.channel);
  const words = estimateWords(text);
  const sentences = splitSentences(text).length;
  const questions = countQuestions(text);
  const chars = text.trim().length;
  const justified = !!opts?.justifiedExtraLength || mode !== 'concise';
  const warnings: string[] = [];
  if (sentences > budget.maxSentences) warnings.push('too_many_sentences');
  if (words > budget.targetWordsMax && !justified)
    warnings.push('over_word_target');
  if (chars > budget.maxChars) warnings.push('over_char_budget');
  if (questions > 1) warnings.push('multiple_questions');
  const withinBudget =
    sentences <= budget.maxSentences &&
    chars <= budget.maxChars &&
    questions <= 1 &&
    (justified || words <= budget.targetWordsMax + 15);
  return {
    words,
    sentences,
    questions,
    chars,
    withinBudget,
    justifiedExtraLength: justified && !withinBudget ? true : justified,
    warnings,
  };
}

/**
 * Tighten a ResponsePlan before compose / LLM: one answer path, optional short
 * narration, single follow-up question. Does not invent content.
 */
export function planConciseResponse(
  plan: ResponsePlan,
  params: {
    customerMessage: string;
    verboseRepliesFlag?: boolean;
    turnKind?: ResponseTurnKind;
    intents?: string[];
    hasCards?: boolean;
    /** Keep more narration for safety / handoff / save failures */
    preserveAll?: boolean;
    channel?: CustomerChannel | null;
    aiPaused?: boolean;
    handoffOpen?: boolean;
  },
): PlannedCustomerReply {
  const turnKind =
    params.turnKind ??
    inferTurnKind({
      intents: params.intents,
      hasCards: params.hasCards,
    });
  const verbosityMode = resolveVerbosityMode({
    customerMessage: params.customerMessage,
    verboseRepliesFlag: params.verboseRepliesFlag,
    turnKind,
  });
  const turnMode = decideTurnMode({
    aiPaused: params.aiPaused,
    handoffOpen:
      params.handoffOpen ||
      turnKind === 'human_handoff' ||
      turnKind === 'complaint',
    hasAnswers: (plan.directAnswer?.length ?? 0) > 0,
    hasQuestion: !!plan.followUpQuestion?.trim(),
    customerFarewell: isCustomerFarewellMessage(params.customerMessage),
  });

  if (params.preserveAll || verbosityMode === 'verbose') {
    const text = [
      plan.acknowledgement,
      ...(plan.directAnswer ?? []),
      ...(plan.actionNarration ?? []),
      plan.followUpQuestion,
    ]
      .filter(Boolean)
      .join(' ');
    return {
      plan,
      verbosityMode,
      turnKind,
      policyVersion: CONVERSATION_POLICY_VERSION,
      length: evaluateLength(text, verbosityMode, {
        justifiedExtraLength: true,
      }),
      droppedNarration: 0,
      droppedAnswers: 0,
    };
  }

  const answers = [...(plan.directAnswer ?? [])]
    .map((s) => s.trim())
    .filter(Boolean);
  const narration = [...(plan.actionNarration ?? [])]
    .map((s) => s.trim())
    .filter(Boolean);

  // Prefer the most useful answer lines; cards carry inventory detail.
  const maxAnswers =
    verbosityMode === 'concise'
      ? params.hasCards
        ? 1
        : 2
      : Math.min(4, answers.length);
  const keptAnswers = answers.slice(0, maxAnswers);
  const droppedAnswers = Math.max(0, answers.length - keptAnswers.length);

  // Narration only when it adds a distinct action status (request saved, etc.).
  const maxNarration =
    verbosityMode === 'concise'
      ? keptAnswers.length === 0
        ? 1
        : turnKind === 'appointment' ||
            turnKind === 'human_handoff' ||
            turnKind === 'complaint' ||
            turnKind === 'trade'
          ? 1
          : 0
      : 2;
  const keptNarration = narration.slice(0, maxNarration);
  const droppedNarration = Math.max(0, narration.length - keptNarration.length);

  // One question max; drop if complaint / farewell-style small talk with no task.
  let followUp = plan.followUpQuestion?.trim();
  if (turnMode === 'wait' || turnMode === 'end') followUp = undefined;
  if (turnMode === 'escalate' && followUp) {
    if (
      !/\b(human|person|agent|specialist|call|connect|transfer)\b/i.test(
        followUp,
      )
    )
      followUp = undefined;
  }
  if (turnKind === 'complaint' && followUp) {
    // Complaints: no sales-progression question; keep only if it's about human help.
    if (
      !/\b(human|person|agent|specialist|call|connect|transfer)\b/i.test(
        followUp,
      )
    )
      followUp = undefined;
  }
  if (
    isCustomerFarewellMessage(params.customerMessage) &&
    keptAnswers.length > 0
  ) {
    followUp = undefined;
  }

  const tightened: ResponsePlan = {
    acknowledgement: plan.acknowledgement,
    directAnswer: keptAnswers.length ? keptAnswers : undefined,
    actionNarration: keptNarration.length ? keptNarration : undefined,
    followUpQuestion: followUp,
    urgency: plan.urgency,
    deliveryStyle: plan.deliveryStyle,
  };

  const preview = [
    tightened.acknowledgement,
    ...(tightened.directAnswer ?? []),
    ...(tightened.actionNarration ?? []),
    tightened.followUpQuestion,
  ]
    .filter(Boolean)
    .join(' ');

  return {
    plan: tightened,
    verbosityMode,
    turnKind,
    policyVersion: CONVERSATION_POLICY_VERSION,
    length: evaluateLength(preview, verbosityMode, {
      channel: params.channel,
    }),
    droppedNarration,
    droppedAnswers,
  };
}

/**
 * Soft post-compose check. Does NOT mid-sentence truncate.
 * Returns whether the reply should be accepted or the caller should fall back
 * to the (already tightened) server draft.
 */
export function acceptCustomerReply(
  reply: string,
  mode: VerbosityMode,
  channel?: CustomerChannel | null,
): { accept: boolean; length: LengthEval; reason?: string } {
  const length = evaluateLength(reply, mode, {
    justifiedExtraLength: mode !== 'concise',
    channel,
  });
  if (length.questions > 1)
    return { accept: false, length, reason: 'multiple_questions' };
  if (length.chars > budgetFor(mode, channel).maxChars)
    return { accept: false, length, reason: 'too_long' };
  if (mode === 'concise' && length.sentences > 2)
    return { accept: false, length, reason: 'too_many_sentences' };
  if (
    mode === 'concise' &&
    length.words > budgetFor(mode, channel).targetWordsMax + 10
  )
    return { accept: false, length, reason: 'too_many_words' };
  // Scripted filler is never acceptable on the customer path.
  if (/\b(i'?d be more than happy|great question|absolutely[!])/i.test(reply))
    return { accept: false, length, reason: 'banned_filler' };
  return { accept: true, length };
}

/** Prefer draft when composed text is over budget; never chop mid-sentence. */
export function chooseReplyWithinBudget(params: {
  composed?: string;
  draft: string;
  mode: VerbosityMode;
  channel?: CustomerChannel | null;
}): { text: string; source: 'composed' | 'draft'; length: LengthEval } {
  const composed = params.composed?.trim();
  if (composed) {
    const check = acceptCustomerReply(composed, params.mode, params.channel);
    if (check.accept)
      return { text: composed, source: 'composed', length: check.length };
  }
  // Draft may still be long (handlers); take first 1–2 sentences when concise.
  const draftTrimmed = trimToSentenceBudget(
    params.draft,
    params.mode,
    params.channel,
  );
  return {
    text: draftTrimmed,
    source: 'draft',
    length: evaluateLength(draftTrimmed, params.mode, {
      channel: params.channel,
    }),
  };
}

/**
 * When forced to use a long deterministic draft, keep complete leading sentences
 * within budget. Never cuts inside a sentence. Preserves a trailing question if
 * it is the only question and fits.
 */
const CAVEAT =
  /\b(estimate|request|preview|in transit|not confirmed|illustrative|example|walk-in|walk in|appointment|without an appointment|simulated|reported|not contacted|can't quote|cannot quote)\b/i;

export function trimToSentenceBudget(
  text: string,
  mode: VerbosityMode,
  channel?: CustomerChannel | null,
): string {
  const budget = budgetFor(mode, channel);
  const sentences = splitSentences(text);
  if (sentences.length === 0) return text.trim();
  if (mode !== 'concise' || sentences.length <= budget.maxSentences) {
    if (text.trim().length <= budget.maxChars) return text.trim();
  }

  const question = [...sentences].reverse().find((s) => /\?\s*$/.test(s));
  const body = sentences.filter((s) => s !== question);
  // Prefer the first sentence plus any caveat-bearing sentence so we never
  // drop "estimate" / "request" labels merely to hit a word target.
  // Caveats may push us to 3 sentences (answer + caveat + question) — justified.
  const keep: string[] = [];
  if (body[0]) keep.push(body[0]);
  const caveat = body.find((s, i) => i > 0 && CAVEAT.test(s));
  if (caveat) keep.push(caveat);
  const maxBody = Math.max(
    keep.length,
    budget.maxSentences - (question ? 1 : 0),
  );
  for (const s of body) {
    if (keep.includes(s)) continue;
    const next = [...keep, s].join(' ');
    if (
      keep.length >= maxBody ||
      estimateWords(next) > budget.targetWordsMax + 20 ||
      next.length > budget.maxChars
    )
      break;
    keep.push(s);
  }
  if (keep.length === 0) keep.push(body[0] ?? sentences[0]);
  if (question && countQuestions(keep.join(' ')) === 0) {
    const withQ = [...keep, question].join(' ');
    if (withQ.length <= budget.maxChars + 120) keep.push(question);
  }
  return keep.join(' ').replace(/\s+/g, ' ').trim();
}
