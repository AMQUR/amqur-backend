import { normalizeCustomerText } from '../understanding/normalize';
import type { Lang } from './dialogue-style';

/**
 * Conversational (social) acts — the layer that lets the concierge talk like a person
 * WITHOUT touching dealership facts.
 *
 * "How are you?" is not a request for verified dealership data and must never reach the
 * knowledge/verification fallback. These acts are classified deterministically, answered
 * from small varied phrase banks, and never carry prices, stock, hours or promises. Anything
 * that asks for a dealership-specific fact is left to the tool-backed intents.
 *
 * The assistant is an AI: it may be friendly ("doing well, thanks for asking") but never
 * claims a body, a life, a commute, or to be a human employee.
 */
export type SocialAct =
  | 'greeting'
  | 'how_are_you'
  | 'reply_wellbeing' // "pretty good", "I'm doing well" (often followed by "you?")
  | 'reply_wellbeing_ask_back' // "good, you?"
  | 'thanks'
  | 'farewell'
  | 'browsing' // "just looking around"
  | 'identity' // "are you a bot / real person?"
  | 'compliment' // "you're helpful", "cool"
  | 'laughter'
  | 'apology' // "sorry, typo"
  | 'shopping_start' // "I want to buy a car" (no vehicle spec yet)
  | 'name_question' // "what's your name?"
  | 'origin_question'; // "why are you texting me?", "I never contacted you"

export type SocialResult = { acts: SocialAct[]; strength: number };

const norm = (s: string) =>
  ` ${normalizeCustomerText(s.toLowerCase())
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .replace(/[^\p{L}\p{N}'?$ ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `;

const HOW_ARE_YOU =
  /\b(how are (?:you|u|ya)|how r u|how(?:'s| is) (?:it going|your day|everything|life)|how(?:'re| are) you doing|how(?:'s| is) it goin|how have you been|how you doing|how do you do|what'?s up|wassup|sup\b|c[oó]mo est[aá]s?|c[oó]mo te va|qu[eé] tal)\b/;
const ASK_BACK =
  /\b(and you|you\?|u\?|yourself|how about you|what about you|and yours|y t[uú]|y usted)\b|\byou\s*\?\s*$/;
const WELLBEING =
  /^\s*(?:i'?m |im |i am |doing |pretty |all |not |been )?(?:good|great|fine|well|ok|okay|alright|all right|not bad|pretty good|doing well|doing good|doing great|wonderful|fantastic|excellent|tired|busy|so so|meh|bien|muy bien|todo bien)\b/;
const GREETING =
  /^\s*(hi|hii+|hello|hey+|heya|hiya|howdy|yo|ello|helo|hullo|hallo|hai|sup|wassup|whats up|what'?s up|good (?:morning|afternoon|evening|day)|morning|evening|hola|buenas(?: tardes| noches| d[ií]as)?|buenos d[ií]as|greetings)\b/;
const THANKS =
  /\b(thanks|thank you|thx|ty|appreciate (?:it|that|you)|gracias|much appreciated)\b/;
const FAREWELL =
  /\b(bye|goodbye|good bye|see you|see ya|talk (?:to you )?later|ttyl|have a good (?:one|day|night)|that'?s all|that is all|i'?m good for now|adi[oó]s|hasta luego)\b/;
const BROWSING =
  /\b(just (?:looking|browsing|checking (?:things )?out)|looking around|browsing|window shopping|not (?:ready|buying) (?:yet|today|right now)|no rush|just curious|solo (?:estoy )?mirando)\b/;
const IDENTITY =
  /\b(?:is this|are you|am i talking to) (?:an? )?(?:actual |real )?(?:person|human) or (?:an? )?(?:ai|bot|robot|machine)|is this (?:an? )?(?:ai|bot|robot|chatbot)|are you chatgpt|am i (?:talking|chatting|speaking) (?:to|with) (?:an? )?(?:robot|machine|computer|bot|ai|human|person|real person)|is there (?:an? )?(?:real |actual )?(?:human|person) (?:on the other end|there|on this|behind this|reading this)|(are you (?:a )?(?:bot|robot|real|human|person|ai|a real person|an ai|a computer|chatgpt|automated)|is this (?:a )?(?:bot|real person|human|ai)|am i (?:talking|chatting) (?:to|with) (?:a )?(?:bot|human|person|real person|ai)|who am i (?:talking|chatting) (?:to|with)|what are you|eres (?:un )?(?:robot|bot|humano|persona))\b/;
const NAME_Q =
  /\b(?:what(?:'s| is) (?:your|ur) name|who (?:are|r) (?:you|u)|do you have a name|what (?:do|should) i call you|what are you called|c[oó]mo te llamas|cu[aá]l es (?:tu|su) nombre)\b/;
const ORIGIN_Q =
  /\b(?:why (?:are|r) (?:you|u) (?:texting|messaging|contacting|calling|emailing|writing to) me|why did (?:you|u) (?:text|message|contact|call|email) me|who (?:is this|texted me)|how did (?:you|u) get my (?:number|email|info)|i (?:never|didn'?t|did not) (?:contact(?:ed)?|text(?:ed)?|message(?:d)?|call(?:ed)?|reach(?:ed)? out to|wr(?:ote|ite) to|sign(?:ed)? up) (?:you|u|for this|for anything)?|stop (?:texting|messaging) me|por qu[eé] me (?:escribe|manda mensajes)|yo no (?:le|te) contact[eé])\b/;
const COMPLIMENT =
  /^\s*(cool|nice|awesome|great|sweet|neat|perfect|love it|good to know|that'?s (?:great|helpful|awesome|cool|nice)|you'?re (?:helpful|great|awesome|good)|very helpful|so helpful)\s*[!.]*\s*$/;
const LAUGH = /^\s*(lol|haha+|hehe+|lmao|jaja+)\b/;
const APOLOGY = /^\s*(sorry|my bad|oops|typo|perd[oó]n)\b/;
const SHOPPING_START =
  /\b(i(?:'m| am)? (?:want(?:ing)? to|wanna|would like to|need to|looking to|thinking (?:about|of)|planning (?:to|on)|trying to|here to|ready to) (?:buy|get|purchase|shop for|lease|find) (?:a |an |me a |myself a |some |my )?(?:new |used |pre-?owned |different )?(?:car|vehicle|truck|suv|ride|something)|(?:shopping|looking|in the market) for (?:a |an )?(?:new |used |pre-?owned )?(?:car|vehicle|truck|suv|ride)|need (?:a |an )?(?:new |used )?(?:car|vehicle|ride)|buy(?:ing)? a (?:new |used )?(?:car|vehicle)|quiero comprar (?:un |una )?(?:carro|auto|coche|camioneta)|busco (?:un |una )?(?:carro|auto|coche))\b/;

/**
 * Classifies social acts. `strength` ~ how much of the message is purely social
 * (1 = nothing else in it). Callers combine this with task intents: a greeting attached to
 * a real request ("hi, do you have Wranglers?") only softens the reply, it never replaces it.
 */
export function classifySocial(message: string): SocialResult {
  const t = norm(message);
  const words = t.trim().split(' ').filter(Boolean).length;
  const acts: SocialAct[] = [];
  const greeting = GREETING.test(t);
  if (greeting) acts.push('greeting');
  if (HOW_ARE_YOU.test(t)) acts.push('how_are_you');
  const wellbeing = WELLBEING.test(t.replace(GREETING, ' ')) && words <= 8;
  if (wellbeing && ASK_BACK.test(t)) acts.push('reply_wellbeing_ask_back');
  else if (wellbeing && !acts.includes('how_are_you'))
    acts.push('reply_wellbeing');
  if (THANKS.test(t)) acts.push('thanks');
  if (FAREWELL.test(t) && words <= 9) acts.push('farewell');
  if (BROWSING.test(t)) acts.push('browsing');
  if (IDENTITY.test(t)) acts.push('identity');
  if (COMPLIMENT.test(t)) acts.push('compliment');
  if (LAUGH.test(t)) acts.push('laughter');
  if (APOLOGY.test(t) && words <= 6) acts.push('apology');
  if (SHOPPING_START.test(t)) acts.push('shopping_start');
  if (NAME_Q.test(t)) acts.push('name_question');
  if (ORIGIN_Q.test(t)) acts.push('origin_question');
  // Strength: remove the social phrases and see how much substance is left.
  let rest = t;
  for (const re of [
    GREETING,
    HOW_ARE_YOU,
    ASK_BACK,
    THANKS,
    FAREWELL,
    BROWSING,
    IDENTITY,
    COMPLIMENT,
    LAUGH,
    APOLOGY,
    NAME_Q,
    ORIGIN_Q,
  ])
    rest = rest.replace(new RegExp(re.source, 'g'), ' ');
  if (wellbeing) rest = rest.replace(WELLBEING, ' ');
  const left = rest
    .replace(
      /\b(there|again|so|much|very|thanks?|today|doing|i'?m|im|and|just|for|the|a|to|you|is|it|this|that|well|oh|ok|okay|guys|man|friend|amigo)\b/g,
      ' ',
    )
    .replace(/[?$']/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  const strength = acts.length ? Math.max(0, 1 - left / Math.max(3, words)) : 0;
  return { acts, strength };
}

/** Deterministic variety: pick an option not used recently; stable per conversation turn. */
export function vary(
  options: string[],
  recent: string[],
  seed: number,
): string {
  const fresh = options.filter((o) => !recent.includes(o));
  const pool = fresh.length ? fresh : options;
  return pool[Math.abs(seed) % pool.length];
}

type Bank = Record<Lang, string[]>;

export const SOCIAL_LINES: Record<string, Bank> = {
  greetingFirst: {
    en: [
      "Hey there! How's your day going?",
      "Hi! Hope your day's going well. What's on your mind?",
      'Hello! Good to see you. How can I help today?',
      "Hey! What's bringing you by today?",
    ],
    es: [
      '¡Hola! ¿Cómo va su día?',
      '¡Hola! Espero que esté teniendo un buen día. ¿En qué le puedo ayudar?',
      '¡Buenas! ¿Qué le trae por aquí hoy?',
    ],
  },
  greetingAgain: {
    en: ['Hey again!', 'Hi again —', 'Welcome back!'],
    es: ['¡Hola de nuevo!', '¡Bienvenido de nuevo!'],
  },
  howAreYou: {
    en: [
      'Doing well, thanks for asking! How about you?',
      "I'm doing great, thanks! How's your day going?",
      'All good on my end — thanks for asking. How are you doing?',
    ],
    es: [
      '¡Muy bien, gracias por preguntar! ¿Y usted?',
      'Todo bien por aquí, gracias. ¿Cómo va su día?',
    ],
  },
  /** Customer answered how they are, and asked back. */
  wellbeingAskBack: {
    en: [
      'Doing well, thanks for asking! What brings you in today?',
      "I'm good, thanks! What can I help you with today?",
      'Doing great, thanks! What are you working on today?',
    ],
    es: [
      '¡Muy bien, gracias por preguntar! ¿Qué le trae por aquí hoy?',
      'Bien, gracias. ¿En qué le puedo ayudar hoy?',
    ],
  },
  wellbeingPositive: {
    en: [
      'Glad to hear it! What brings you in today?',
      "Good to hear. What's on your list today?",
      'Love that. What can I help you with?',
    ],
    es: [
      '¡Qué bueno! ¿Qué le trae por aquí hoy?',
      'Me alegra. ¿En qué le puedo ayudar?',
    ],
  },
  wellbeingLow: {
    en: [
      "Sorry to hear that — I'll try to make this part easy. What can I help with?",
      "Hope the rest of the day's kinder. What can I take off your plate?",
    ],
    es: ['Lamento oír eso — intentaré hacerle esto fácil. ¿En qué le ayudo?'],
  },
  browsing: {
    en: [
      'No rush at all — browse as much as you like. If anything catches your eye, I can pull it up or answer questions.',
      "Totally fine. Look around, and if you'd like, tell me what you drive now or what you're curious about and I'll point you to a few worth seeing.",
      "Sounds good. I'm here whenever a question comes up — no pressure.",
    ],
    es: [
      'Sin prisa — vea con calma. Si algo le llama la atención, se lo muestro o le respondo preguntas.',
      'Perfecto. Aquí estoy cuando surja alguna pregunta — sin presión.',
    ],
  },
  thanks: {
    en: ["You're welcome!", 'Anytime!', 'Happy to help.', 'Of course!'],
    es: ['¡Con gusto!', '¡Para servirle!', 'De nada.'],
  },
  farewell: {
    en: [
      'Thanks for stopping by — have a great day!',
      'Take care! I’m here if anything else comes up.',
      'Have a good one! Come back anytime.',
    ],
    es: [
      '¡Gracias por visitarnos — que tenga un excelente día!',
      '¡Cuídese! Aquí estoy si surge algo más.',
    ],
  },
  identity: {
    en: [
      "I'm an AI assistant for the dealership — not a person. I can search inventory, run payment estimates and set up requests, and I can bring in someone from the team whenever you'd like.",
      "I'm the dealership's AI assistant. I'll be straight with you about what I can confirm, and I can connect you with a real person anytime.",
    ],
    es: [
      'Soy un asistente de IA de la agencia — no una persona. Puedo buscar inventario, estimar pagos y hacer solicitudes, y le conecto con alguien del equipo cuando quiera.',
    ],
  },
  compliment: {
    en: ['Glad that helps!', 'Happy to hear it.', 'Thanks!'],
    es: ['¡Qué bueno que le sirva!', '¡Gracias!'],
  },
  laughter: {
    en: ['Ha!', 'Glad that got a laugh.'],
    es: ['¡Ja!'],
  },
  apology: {
    en: ['No worries at all.', 'All good!'],
    es: ['No se preocupe.', '¡Todo bien!'],
  },
  shoppingStart: {
    en: [
      'Nice! Do you already have something in mind, or are you still exploring?',
      'Exciting! Is there a model you have your eye on, or should we narrow it down together?',
      'Fun! What are you thinking — anything specific, or still figuring out what fits?',
    ],
    es: [
      '¡Qué bien! ¿Ya tiene algo en mente o todavía está explorando?',
      '¡Excelente! ¿Tiene algún modelo en mente o lo vamos definiendo juntos?',
    ],
  },
  /** Gentle discovery prompts when exploring (one question at a time). */
  discovery: {
    en: [
      'What will you mostly use it for — commuting, family, towing, weekend trips?',
      'Any must-haves? Things like seating for seven, 4x4, or a budget you want to stay around.',
      'Are you leaning SUV, truck, or something else?',
    ],
    es: [
      '¿Para qué lo usará principalmente — trabajo, familia, remolque, paseos?',
      '¿Algo indispensable? Por ejemplo siete asientos, 4x4 o un presupuesto.',
    ],
  },
};

export function socialLine(
  key: keyof typeof SOCIAL_LINES,
  lang: Lang,
  recent: string[],
  seed: number,
): string {
  const bank = SOCIAL_LINES[key][lang] ?? SOCIAL_LINES[key].en;
  return vary(bank, recent, seed);
}

/** Small stable hash for seeding variety from conversation id + turn. */
export function seedOf(...parts: Array<string | number | undefined>): number {
  let h = 2166136261;
  for (const ch of parts.filter((p) => p !== undefined).join('|')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
