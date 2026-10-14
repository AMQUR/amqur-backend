import type {
  Sentiment,
  TurnIntent,
} from '../understanding/turn-understanding';

export type Lang = 'en' | 'es';
export const tr = (lang: Lang | undefined, en: string, es: string) =>
  lang === 'es' ? es : en;

export type ResponsePlan = {
  acknowledgement?: string;
  directAnswer?: string[];
  actionNarration?: string[];
  followUpQuestion?: string;
  urgency?: 'normal' | 'urgent';
  deliveryStyle?: 'single' | 'split';
};

const FILLER =
  /^(absolutely|great question|i'?d be happy to help|certainly|of course|sure thing)[!,.]?\s*/i;

/**
 * Acknowledge only when it carries meaning: frustration, anxiety, a correction, a commitment,
 * or a sensitive trade/payment concern. Plain factual questions get a direct answer.
 */
export function chooseAcknowledgement(params: {
  sentiment: Sentiment;
  intents: TurnIntent[];
  isCorrection: boolean;
  lang: Lang;
  recentOpeners: string[];
}): string | undefined {
  const { sentiment, intents, isCorrection, lang, recentOpeners } = params;
  const pick = (options: string[]) =>
    options.find((o) => !recentOpeners.includes(o)) ?? undefined;
  if (sentiment === 'frustrated') {
    return pick(
      lang === 'es'
        ? [
            'Lamento que haya tenido que insistir tanto.',
            'Entiendo la frustración — no debería costar tanto obtener ayuda.',
          ]
        : [
            "I'm sorry you've had to chase this.",
            "That's frustrating — you shouldn't have to work this hard to get help.",
          ],
    );
  }
  if (sentiment === 'anxious') {
    return pick(
      lang === 'es'
        ? [
            'Es una preocupación muy común, y hay opciones.',
            'Tiene sentido querer tenerlo claro antes de decidir.',
          ]
        : [
            "That's a really common concern, and there are options.",
            'It makes sense to want clarity before deciding.',
          ],
    );
  }
  if (isCorrection) {
    return pick(
      lang === 'es'
        ? ['Sin problema.', 'Claro, lo cambio.']
        : ['No problem.', 'Got it — updating that.'],
    );
  }
  if (
    intents.includes('CREDIT_APPLICATION') ||
    intents.includes('SALES_APPOINTMENT') ||
    intents.includes('SERVICE_APPOINTMENT')
  ) {
    return pick(
      lang === 'es' ? ['Perfecto.', 'Muy bien.'] : ['Sounds good.', 'Perfect.'],
    );
  }
  return undefined;
}

export function stripFiller(text: string): string {
  return text.replace(FILLER, '').trim();
}

export function compose(plan: ResponsePlan): {
  text: string;
  segments: string[];
} {
  const body = [...(plan.directAnswer ?? []), ...(plan.actionNarration ?? [])]
    .map((s) => s.trim())
    .filter(Boolean);
  const first = [plan.acknowledgement, ...body].filter(Boolean).join(' ');
  const q = plan.followUpQuestion?.trim();
  const text = [first, q].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  // Split only when it genuinely helps readability: long narrative + a question.
  const split = plan.deliveryStyle === 'split' || (first.length > 260 && !!q);
  const segments = split && q ? [first, q] : [text];
  return { text, segments };
}

export function signature(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').slice(0, 200);
}

/** Presentation timing hint for the widget (actual backend work is never delayed). */
export function deliveryHint(params: {
  textLength: number;
  toolCount: number;
  urgent: boolean;
  isError: boolean;
}) {
  if (params.urgent || params.isError)
    return { minTypingMs: 0, maxTypingMs: 0 };
  const base =
    450 +
    Math.min(1600, params.textLength * 6) +
    Math.min(600, params.toolCount * 200);
  return {
    minTypingMs: Math.min(base, 2200),
    maxTypingMs: Math.min(base + 600, 2800),
  };
}
