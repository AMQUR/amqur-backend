import { resolveWhen, ResolvedWhen } from '../../common/time/date-phrase';
import {
  detectCreditSensitive,
  SensitiveKind,
} from '../../common/security/sensitive-data';
import { classifySocial, SocialAct } from '../dialogue/social';
import { normalizeCustomerText } from './normalize';

/**
 * Deterministic, multi-intent turn understanding.
 *
 * Replaces first-substring-wins routing. Every rule produces an intent WITH evidence and a
 * confidence; several intents can fire in one turn ("I have a 2021 Accord to trade, want the
 * black Wrangler you showed me, need to stay under $650 a month, and can come Saturday
 * afternoon" → TRADE_IN + SELECT_VEHICLE + PAYMENT_ESTIMATE + SALES_APPOINTMENT).
 * Ambiguous words (open, close, agent, new, car, filter, service, hold, finance, appointment)
 * only count with disambiguating context. Conversation state (what the assistant just asked)
 * is used to interpret short replies. An optional schema-constrained LLM classifier may be
 * layered on top for low-confidence turns, but routing never depends on it.
 */

export type TurnIntent =
  | 'INVENTORY_SEARCH'
  | 'FEATURE_FILTER'
  | 'SELECT_VEHICLE'
  | 'VEHICLE_QUESTION'
  | 'COMPARE'
  | 'PAYMENT_ESTIMATE'
  | 'FINANCE_REQUEST'
  | 'CREDIT_APPLICATION'
  | 'TRADE_IN'
  | 'SALES_APPOINTMENT'
  | 'SERVICE_APPOINTMENT'
  | 'APPOINTMENT_RESCHEDULE'
  | 'APPOINTMENT_CANCEL'
  | 'SERVICE_AMENITY_QUESTION'
  | 'SERVICE_STATUS'
  | 'PARTS_INQUIRY'
  | 'HOURS_LOCATION'
  | 'HUMAN_HANDOFF'
  | 'COMPLAINT'
  | 'HOLD_REQUEST'
  | 'KNOWLEDGE_QUESTION'
  | 'PROVIDE_CONTACT'
  | 'AFFIRM'
  | 'DECLINE'
  | 'TEXT_CONTINUATION'
  | 'LANGUAGE_SWITCH'
  | 'GREETING'
  | 'SMALL_TALK'
  | 'SHOPPING_START'
  | 'OTD_QUOTE'
  | 'PURCHASE_START'
  | 'CHANGE_OF_MIND'
  | 'RESUME_VEHICLE'
  | 'SAFETY_URGENT'
  | 'UNKNOWN';

export type Sentiment = 'neutral' | 'frustrated' | 'anxious' | 'positive';

export type TurnEntities = {
  /** The customer asked for a phone number to call ("service department's phone number?"). */
  askPhone?: boolean;
  vin?: string;
  stock?: string;
  partNumber?: string;
  vehicle?: {
    year?: number;
    yearMin?: number;
    make?: string;
    model?: string;
    trim?: string;
    color?: string;
    bodyType?: string;
    drivetrain?: string;
    condition?: 'new' | 'used' | 'certified';
    fuel?: 'electric' | 'hybrid' | 'gas' | 'diesel';
    maxMileage?: number;
    seatsMin?: number;
  };
  features?: string[];
  maxPrice?: number;
  maxMonthly?: number;
  downPayment?: number;
  termMonths?: number;
  customerApr?: number;
  leaseOrPurchase?: 'lease' | 'purchase' | 'cash';
  /** Conversational acts in this turn (greeting, "how are you", thanks, …). */
  social?: SocialAct[];
  /** 0..1 — how much of the message is purely social. */
  socialStrength?: number;
  /** "the two nicest", "cheapest one", "newest" — ranking over vehicles already shown. */
  rank?: {
    by: 'price_desc' | 'price_asc' | 'year_desc' | 'miles_asc';
    count?: number;
  };
  /** The customer is talking about a vehicle they OWN ("my other Jeep") — never a shopping target. */
  ownVehicle?: { make?: string; model?: string; year?: number };
  /** Additional models named in the same message, in order ("X or Y?"). */
  alternativeModels?: string[];
  /** Registration ZIP for an out-the-door quote. */
  zip?: string;
  /** "does that mean I'm approved?" */
  approvalQuestion?: boolean;
  /** Customer signals credit worries ("my credit isn't great", "bad credit", "little down"). */
  creditConcern?: boolean;
  /** "What do I need to bring?" — documents question inside a purchase/visit. */
  bringQuestion?: boolean;
  /** Customer says the assistant is not answering ("you keep dodging my question"). */
  notAnswered?: boolean;
  /** "How much is it?" about the selected/shown vehicle — the selling price, not a payment. */
  priceQuestion?: boolean;
  /** "How long has it been on your lot?" */
  lotAgeQuestion?: boolean;
  /** "Who is your manager?" — an identity question, not a callback request. */
  managerQuestion?: boolean;
  /** Short conversational follow-ups that refer to the previous assistant message. */
  followUp?:
    | 'what_do_you_mean'
    | 'why'
    | 'hold_on'
    | 'show_me'
    | 'send_it'
    | 'that_one'
    | 'who_is_that';
  /** Expressed interest without naming anything ("yes I'm interested"). */
  interest?: boolean;
  /** Visit time described loosely ("after work", "in the evening") — needs an exact time. */
  looseTime?: 'after_work' | 'morning' | 'afternoon' | 'evening' | 'lunch';
  /** "go back to the Wrangler" — resume an earlier vehicle instead of searching again. */
  resume?: boolean;
  trade?: {
    year?: number;
    make?: string;
    model?: string;
    mileage?: number;
    payoff?: number;
  };
  when?: ResolvedWhen;
  serviceNeed?: string;
  partNeed?: string;
  contact?: {
    firstName?: string;
    lastName?: string;
    phone?: string;
    email?: string;
  };
  referencesPrior?: boolean;
  language?: 'en' | 'es';
  timeline?: string;
  amenity?: 'shuttle' | 'loaner' | 'rideshare' | 'wifi' | 'wait';
  sensitive?: SensitiveKind[];
};

export type ScoredIntent = {
  intent: TurnIntent;
  confidence: number;
  evidence: string;
};

export type TurnUnderstanding = {
  intents: ScoredIntent[];
  primary: TurnIntent;
  entities: TurnEntities;
  sentiment: Sentiment;
  isQuestion: boolean;
};

/** What the assistant last asked — lets short answers ("Saturday", "Mike", "yes") route correctly. */
export type PendingQuestion =
  | 'none'
  | 'appointment_date'
  | 'appointment_time'
  | 'contact_name'
  | 'contact_method'
  | 'vehicle_choice'
  | 'parts_vin'
  | 'service_need'
  | 'confirm_handoff'
  | 'confirm_credit_link'
  | 'text_consent'
  | 'service_vehicle'
  | 'otd_zip'
  | 'payment_method';

export const MAKES = [
  'acura',
  'alfa romeo',
  'audi',
  'bmw',
  'buick',
  'cadillac',
  'chevrolet',
  'chevy',
  'chrysler',
  'dodge',
  'fiat',
  'ford',
  'genesis',
  'gmc',
  'honda',
  'hyundai',
  'infiniti',
  'jaguar',
  'jeep',
  'kia',
  'land rover',
  'lexus',
  'lincoln',
  'mazda',
  'mercedes',
  'mercedes-benz',
  'mini',
  'mitsubishi',
  'nissan',
  'polestar',
  'porsche',
  'ram',
  'rivian',
  'subaru',
  'tesla',
  'toyota',
  'volkswagen',
  'vw',
  'volvo',
];

export const MODELS: Record<string, string> = {
  wrangler: 'Jeep',
  'grand cherokee': 'Jeep',
  cherokee: 'Jeep',
  compass: 'Jeep',
  gladiator: 'Jeep',
  renegade: 'Jeep',
  wagoneer: 'Jeep',
  'grand wagoneer': 'Jeep',
  qx50: 'INFINITI',
  qx55: 'INFINITI',
  qx60: 'INFINITI',
  qx80: 'INFINITI',
  q50: 'INFINITI',
  kicks: 'Nissan',
  versa: 'Nissan',
  murano: 'Nissan',
  armada: 'Nissan',
  ariya: 'Nissan',
  trax: 'Chevrolet',
  trailblazer: 'Chevrolet',
  corvette: 'Chevrolet',
  camaro: 'Chevrolet',
  cayenne: 'Porsche',
  accord: 'Honda',
  civic: 'Honda',
  'cr-v': 'Honda',
  crv: 'Honda',
  pilot: 'Honda',
  odyssey: 'Honda',
  'hr-v': 'Honda',
  camry: 'Toyota',
  corolla: 'Toyota',
  rav4: 'Toyota',
  highlander: 'Toyota',
  tacoma: 'Toyota',
  tundra: 'Toyota',
  '4runner': 'Toyota',
  prius: 'Toyota',
  sienna: 'Toyota',
  'f-150': 'Ford',
  f150: 'Ford',
  bronco: 'Ford',
  explorer: 'Ford',
  escape: 'Ford',
  mustang: 'Ford',
  'mach-e': 'Ford',
  maverick: 'Ford',
  ranger: 'Ford',
  expedition: 'Ford',
  silverado: 'Chevrolet',
  equinox: 'Chevrolet',
  tahoe: 'Chevrolet',
  suburban: 'Chevrolet',
  traverse: 'Chevrolet',
  malibu: 'Chevrolet',
  colorado: 'Chevrolet',
  blazer: 'Chevrolet',
  '1500': 'Ram',
  '2500': 'Ram',
  durango: 'Dodge',
  charger: 'Dodge',
  challenger: 'Dodge',
  hornet: 'Dodge',
  pacifica: 'Chrysler',
  altima: 'Nissan',
  rogue: 'Nissan',
  sentra: 'Nissan',
  pathfinder: 'Nissan',
  frontier: 'Nissan',
  'model 3': 'Tesla',
  'model y': 'Tesla',
  outback: 'Subaru',
  forester: 'Subaru',
  crosstrek: 'Subaru',
  tucson: 'Hyundai',
  'santa fe': 'Hyundai',
  elantra: 'Hyundai',
  'ioniq 5': 'Hyundai',
  telluride: 'Kia',
  sportage: 'Kia',
  sorento: 'Kia',
  'cx-5': 'Mazda',
  'cx-50': 'Mazda',
  'cx-90': 'Mazda',
};

const COLORS = [
  'black',
  'white',
  'silver',
  'gray',
  'grey',
  'red',
  'blue',
  'green',
  'orange',
  'yellow',
  'brown',
  'beige',
  'gold',
  'purple',
  'negro',
  'blanco',
  'rojo',
  'azul',
  'gris',
  'plata',
];
const COLOR_ES: Record<string, string> = {
  negro: 'black',
  blanco: 'white',
  rojo: 'red',
  azul: 'blue',
  gris: 'gray',
  plata: 'silver',
  grey: 'gray',
};

export const FEATURE_SYNONYMS: Record<string, string[]> = {
  'heated seats': [
    'heated seat',
    'heated front seat',
    'asientos calefactados',
    'asientos con calefacción',
  ],
  'heated steering wheel': ['heated steering', 'heated wheel'],
  leather: ['leather seat', 'leather interior', 'cuero'],
  sunroof: ['sunroof', 'moonroof', 'panoramic roof', 'sky roof', 'techo solar'],
  'third row': [
    'third row',
    '3rd row',
    'seven seat',
    '7 seat',
    '7-seat',
    'tercera fila',
  ],
  'apple carplay': ['carplay', 'apple carplay'],
  'android auto': ['android auto'],
  navigation: ['navigation', ' nav ', 'gps', 'navegación'],
  'backup camera': [
    'backup camera',
    'rear camera',
    'rearview camera',
    'cámara de reversa',
  ],
  'blind spot monitoring': ['blind spot', 'blind-spot'],
  'adaptive cruise control': ['adaptive cruise'],
  'remote start': ['remote start'],
  'tow package': [
    'tow package',
    'towing package',
    'trailer hitch',
    'tow hitch',
  ],
  'ventilated seats': ['ventilated seat', 'cooled seat'],
};

const WORD_NUM: Record<string, number> = {
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
};

function moneyToNumber(raw: string, suffix?: string): number | null {
  const n = Number(raw.replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n)) return null;
  const s = (suffix ?? '').toLowerCase().trim();
  if (s === 'k' || s === 'grand' || s === 'thousand' || s === 'mil')
    return Math.round(n * 1000);
  return Math.round(n);
}

const NAME_STOPWORDS = new Set([
  'yes',
  'yeah',
  'yep',
  'sure',
  'ok',
  'okay',
  'no',
  'nope',
  'nah',
  'thanks',
  'thank',
  'hi',
  'hello',
  'hey',
  'hola',
  'please',
  'maybe',
  'cool',
  'great',
  'perfect',
  'fine',
  'good',
  'sounds',
  'later',
  'today',
  'tomorrow',
  'saturday',
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'morning',
  'afternoon',
  'evening',
  'service',
  'sales',
  'parts',
  'finance',
  'help',
  'what',
  'why',
  'how',
  'when',
  'where',
  'who',
  'that',
  'this',
  'those',
  'the',
  'a',
  'an',
  'si',
  'sí',
  'gracias',
  'bueno',
  'claro',
  'nothing',
  'none',
  'stop',
  'test',
  'asap',
  'buenas',
  'buenos',
  'tardes',
  'noches',
  'dias',
  'días',
  'good',
  'night',
  'day',
  // wellbeing / browsing words that follow "I'm …" but are never names
  'doing',
  'well',
  'pretty',
  'just',
  'looking',
  'browsing',
  'interested',
  'thinking',
  'tired',
  'busy',
  'here',
  'ready',
  'sorry',
  'not',
  'so',
  'all',
  'alright',
  'excited',
  'curious',
  'shopping',
  'trying',
  'paying',
  'from',
  'in',
  'on',
  'at',
  ...Object.keys(MODELS),
  ...MAKES,
]);

/** Display a model the way manufacturers write it: "QX60", "RAV4", "CR-V", "F-150", "Grand Cherokee". */
export function displayModel(key: string): string {
  const special: Record<string, string> = {
    'cr-v': 'CR-V',
    crv: 'CR-V',
    f150: 'F-150',
    'f-150': 'F-150',
    'hr-v': 'HR-V',
  };
  if (special[key]) return special[key];
  return key
    .split(' ')
    .map((w) =>
      /\d/.test(w) && /[a-z]/.test(w)
        ? w.toUpperCase()
        : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join(' ');
}

function editDistance(a: string, b: string): number {
  const dp = Array.from(
    { length: a.length + 1 },
    (_, i) => [i, ...Array(b.length).fill(0)] as number[],
  );
  for (let j = 1; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1)
    for (let j = 1; j <= b.length; j += 1)
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return dp[a.length][b.length];
}

/** Typo-tolerant single-word model match ("wrangeler" → wrangler). Conservative: len≥6, distance≤2. */
/** Ordinary words that sit within edit distance 2 of a model name ("compare" ~ "compass"). */
const FUZZY_STOP = new Set([
  'compare',
  'compared',
  'company',
  'complete',
  'campus',
  'pilots',
  'acorde',
  'ranger',
  'escape',
  'change',
  'charge',
  'charges',
  'charged',
  'traverse',
  'renewal',
  'renegade',
  'wrangle',
  'changed',
  'charged',
  'charges',
  'changes',
  'charter',
]);

export function fuzzyModel(text: string): string | null {
  const words = text.toLowerCase().match(/[a-z0-9-]{5,}/g) ?? [];
  for (const w of words) {
    if (FUZZY_STOP.has(w) || MODELS[w]) continue;
    if (w.length === 5) {
      // Short words: one edit only, and only against models of the same length.
      for (const m of Object.keys(MODELS)) {
        if (m.length !== 5 || m.includes(' ')) continue;
        if (editDistance(w, m) === 1) return m;
        // one adjacent swap ("rouge" → "rogue")
        for (let i = 0; i < 4; i += 1)
          if (w === m.slice(0, i) + m[i + 1] + m[i] + m.slice(i + 2)) return m;
      }
      continue;
    }
    // 6–7 letters: one edit ("changed" must never become "charger"); 8+: two edits.
    const budget = w.length >= 8 ? 2 : 1;
    for (const m of Object.keys(MODELS)) {
      if (m.includes(' ') || m.length < 6) continue;
      if (
        Math.abs(m.length - w.length) <= budget &&
        editDistance(w, m) <= budget
      )
        return m;
    }
  }
  return null;
}

export function extractContact(
  text: string,
  pending: PendingQuestion,
): TurnEntities['contact'] | undefined {
  const out: NonNullable<TurnEntities['contact']> = {};
  const email = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.exec(text);
  if (email) out.email = email[0].toLowerCase();
  const phone =
    /(?:\+?1[\s.-]?)?\(?\b(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/.exec(text);
  if (phone && !/\b[A-HJ-NPR-Z0-9]{17}\b/i.test(text.replace(/\s/g, ''))) {
    out.phone = `${phone[1]}${phone[2]}${phone[3]}`;
  }
  const intro =
    /\b(?:my name is|my name's|this is|i am|i'm|me llamo|soy)\s+([A-Za-zÀ-ÿ'-]{2,30})(?:\s+([A-Za-zÀ-ÿ'-]{2,30}))?/i.exec(
      text,
    );
  if (intro) {
    const first = intro[1];
    const last = intro[2];
    const verbish =
      /^(looking|interested|trying|calling|here|going|not|just|ready|pissed|mad|frustrated|upset|from|in|at|on|a|an|the|so|very|coming|thinking|wondering|happy)$/i;
    // "I'm …" is usually a state ("I'm approved", "I'm doing well"), not a name. Accept it as
    // a name only when it's explicit ("my name is"), capitalized like a name, or we just asked.
    const explicit = /\b(my name is|my name's|this is|me llamo)\b/i.test(
      intro[0],
    );
    const nameLike =
      explicit ||
      pending === 'contact_name' ||
      (/^[A-ZÀ-Ý]/.test(first) && !/(ed|ing)$/i.test(first));
    if (
      nameLike &&
      !verbish.test(first) &&
      !NAME_STOPWORDS.has(first.toLowerCase()) &&
      !/^(approved|pre-?approved|done|sure|new|available|paying|buying|good|okay)$/i.test(
        first,
      )
    ) {
      out.firstName = cap(first);
      if (
        last &&
        !verbish.test(last) &&
        !NAME_STOPWORDS.has(last.toLowerCase())
      )
        out.lastName = cap(last);
    }
  } else if (
    pending === 'contact_name' ||
    // "Mike Jones 312-555-0188" in answer to "best number?": a capitalized name next to the
    // number they were asked for.
    (pending === 'contact_method' &&
      (out.phone || out.email) &&
      /^\s*[A-ZÀ-Ý][a-zà-ÿ'-]+(?:\s+[A-ZÀ-Ý][a-zà-ÿ'-]+){0,2}\s*[,:-]?\s*(?:\+?1|\(?\d{3}|[A-Za-z0-9._%+-]+@)/.test(
        text,
      ))
  ) {
    // Only treat a bare short reply as a name when we just asked for one. Contact details in
    // the same reply ("Mike Chen, 312-555-0199") are removed first.
    const clean = text
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, ' ')
      .replace(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g, ' ')
      .replace(/[,;.!]+/g, ' ')
      .replace(/\b(and|my|number|phone|email|is|at)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const words = clean.split(/\s+/);
    if (
      words.length >= 1 &&
      words.length <= 3 &&
      /^[A-Za-zÀ-ÿ'\s-]+$/.test(clean) &&
      !NAME_STOPWORDS.has(words[0].toLowerCase())
    ) {
      out.firstName = cap(words[0]);
      if (words[1] && !NAME_STOPWORDS.has(words[1].toLowerCase()))
        out.lastName = cap(words.slice(1).join(' '));
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function cap(s: string) {
  // Brands written in capitals by their manufacturers.
  const brand: Record<string, string> = {
    infiniti: 'INFINITI',
    bmw: 'BMW',
    gmc: 'GMC',
    mini: 'MINI',
  };
  if (brand[s.toLowerCase()]) return brand[s.toLowerCase()];
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

export function detectLanguage(text: string): 'en' | 'es' | undefined {
  const hasInvQ = /[¿¡ñ]/.test(text);
  const t = ` ${text.toLowerCase().replace(/[.,!?¿¡;:()]/g, ' ')} `;
  const es = [
    ' hola ',
    ' quiero ',
    ' necesito ',
    ' busco ',
    ' cuánto ',
    ' cuanto ',
    ' gracias ',
    ' camioneta ',
    ' coche ',
    ' carro ',
    ' por favor ',
    ' mañana ',
    ' cita ',
    ' tienen ',
    ' precio ',
    ' pago ',
    ' sábado ',
    ' sabado ',
    ' puedo ',
    ' español ',
    ' usted ',
    ' quisiera ',
    ' llamo ',
    ' ¿',
    'ñ',
  ];
  const en = [
    ' the ',
    ' i ',
    ' you ',
    ' want ',
    ' need ',
    ' looking ',
    ' have ',
    ' can ',
    ' what ',
    ' is ',
    ' my ',
    ' please ',
    ' are ',
    ' your ',
    ' do ',
    ' how ',
    ' show ',
    ' me ',
    ' hours ',
    ' price ',
    ' thanks ',
    ' needs ',
    ' an ',
    ' and ',
    ' to ',
    ' for ',
    ' it ',
    ' other ',
  ];
  const sEs = es.reduce((a, w) => a + (t.includes(w) ? 1 : 0), 0);
  const sEn = en.reduce((a, w) => a + (t.includes(w) ? 1 : 0), 0);
  if (/\b(in english|en inglés|en ingles|english please)\b/.test(t))
    return 'en';
  if (
    /\b(en español|en espanol|in spanish|habla español|hablas español)\b/.test(
      t,
    )
  )
    return 'es';
  if (sEs >= 2 && sEs > sEn) return 'es';
  // Short Spanish messages ("hola", "¿Tienen Compass?", "buenas tardes") carry one strong cue.
  const strong =
    hasInvQ ||
    /\b(hola|buenas|buenos|gracias|tienen|cuánto|cuanto|quiero|busco|necesito|sería|seria)\b/.test(
      t,
    );
  if (strong && sEn === 0) return 'es';
  // A plain English sentence switches back after Spanish ("What are your hours?").
  if (sEn >= 2 && sEs === 0 && !hasInvQ) return 'en';
  if (sEn >= 2 && sEn > sEs) return 'en';
  return undefined;
}

/** Concepts (not vehicles) people compare: "AWD vs 4WD", "lease or finance", "hybrid vs EV". */
export const GENERAL_TOPIC =
  /\b(awd|4wd|4x4|fwd|rwd|all[- ]wheel|four[- ]wheel|front[- ]wheel|rear[- ]wheel|lease|leasing|financ\w*|loan|hybrid|plug[- ]in|phev|ev|electric|gas|diesel|turbo|msrp|invoice|apr|gap insurance|extended warranty|certified|cpo|new (?:and|or|vs\.?) used)\b/;

export function understandTurn(
  message: string,
  ctx: {
    pending?: PendingQuestion;
    hasVisibleVehicles?: boolean;
    hasSelectedVehicle?: boolean;
    hasActiveAppointment?: boolean;
    activeDepartment?: 'sales' | 'service' | 'parts' | 'finance' | null;
    timeZone: string;
    now?: Date;
    /** Models of vehicles already shown/selected in this conversation (lowercase). */
    knownModels?: string[];
    /** Trims of vehicles on screen (lowercase), e.g. "series ii 4x4", "rubicon 4xe". */
    knownTrims?: string[];
    hasPaymentEstimate?: boolean;
    hasCriteria?: boolean;
    creditOffered?: boolean;
  },
): TurnUnderstanding {
  const raw = message.trim();
  const t = ` ${normalizeCustomerText(
    raw.toLowerCase().replace(/[“”]/g, '"').replace(/[’]/g, "'"),
  )} `;
  const intents: ScoredIntent[] = [];
  const add = (intent: TurnIntent, confidence: number, evidence: string) => {
    const ex = intents.find((i) => i.intent === intent);
    if (ex) {
      ex.confidence = Math.max(ex.confidence, confidence);
      return;
    }
    intents.push({ intent, confidence, evidence });
  };
  const e: TurnEntities = {};
  const pending = ctx.pending ?? 'none';

  const sensitive = detectCreditSensitive(raw);
  if (sensitive.length) e.sensitive = sensitive;

  e.language = detectLanguage(raw);
  if (
    /\b(en español|en espanol|in spanish|habla español|hablas español)\b/.test(
      t,
    )
  )
    add('LANGUAGE_SWITCH', 0.95, 'spanish request');
  if (/\b(in english|en inglés|en ingles|english please)\b/.test(t))
    add('LANGUAGE_SWITCH', 0.95, 'english request');

  // ── identifiers
  const vin = /\b([A-HJ-NPR-Z0-9]{17})\b/i.exec(raw);
  if (vin && /\d/.test(vin[1]) && /[A-Z]/i.test(vin[1]))
    e.vin = vin[1].toUpperCase();
  const stock =
    /\bstock\s*(?:#|number|no\.?)?\s*:?\s*([A-Z0-9-]{3,12})\b/i.exec(raw);
  if (stock) e.stock = stock[1].toUpperCase();
  const pn =
    /\bpart\s*(?:#|number|no\.?)\s*:?\s*([A-Z0-9][A-Z0-9-]{4,24})\b/i.exec(raw);
  if (pn) e.partNumber = pn[1].toUpperCase();

  // ── trade-in (parse BEFORE desired vehicle so "2021 Accord to trade" isn't the shopping target)
  const tradeCue =
    /\b(trade[- ]?in|trading in|to trade|my trade|trade my|trade it|appraisal|appraise|what'?s my (?:car|truck|vehicle) worth|i (?:have|got|own) an? (?:\d{4} )?[a-z-]+ (?:with|to trade|that i)|i'?ve got an? \d{4}|tengo un[ao]? \d{4}|intercambio|dar a cuenta)\b/;
  let tradeSpan = '';
  if (
    tradeCue.test(t) ||
    (/\bi(?:'ve| have)? got an? \d{4}\b|\bi have an? \d{4}\b/.test(t) &&
      /\b(miles|mi|k miles)\b/.test(t))
  ) {
    const m =
      /\b(?:have|got|own|trade(?: in)?|trading(?: in)?|tengo)\s+(?:a |an |my |un |una )?(\d{4})\s+([a-z-]+)(?:\s+([a-z0-9-]+))?/.exec(
        t,
      );
    e.trade = {};
    if (m) {
      e.trade.year = Number(m[1]);
      const w2 = m[2];
      const w3 = m[3];
      if (MODELS[w2]) {
        e.trade.make = MODELS[w2];
        e.trade.model = cap(w2);
      } else if (MAKES.includes(w2)) {
        e.trade.make = cap(w2);
        if (
          w3 &&
          !['with', 'to', 'that', 'and', 'for', 'con', 'que'].includes(w3)
        )
          e.trade.model = cap(w3);
      } else {
        e.trade.model = cap(w2);
      }
      tradeSpan = m[0];
    }
    const miles =
      /(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k)?\s*(?:miles|mi\b|millas)/.exec(
        t,
      );
    if (miles) {
      const n = moneyToNumber(miles[1], miles[2]);
      if (n) e.trade.mileage = n;
    }
    const payoff =
      /\b(?:owe|payoff|pay off)\s*(?:about|around)?\s*\$?\s*(\d[\d,.]*)\s*(k|grand)?/.exec(
        t,
      );
    if (payoff)
      e.trade.payoff = moneyToNumber(payoff[1], payoff[2]) ?? undefined;
    add('TRADE_IN', m || miles ? 0.92 : 0.8, 'trade cue');
  }

  let tShop = tradeSpan ? t.replace(tradeSpan, ' ') : t;
  // "service for my other Jeep" / "my 2019 Cherokee needs brakes" → owned vehicle, not a shopping target
  const own =
    /\bmy (?:other |old |current |wife'?s |husband'?s |)(?:(\d{4}) )?([a-z-]+)(?: ([a-z][a-z0-9-]*))?/.exec(
      tShop,
    );
  if (
    own &&
    !/\b(my (?:trade|budget|payment|credit|rate|appointment|order|name|number|email|vin))\b/.test(
      own[0],
    ) &&
    !/\b(?:show|see|find|search|browse|pull up)\s+my\b/.test(tShop) &&
    !new RegExp(
      `${own[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(?:inventory|stock|options|listings|search)`,
    ).test(tShop)
  ) {
    const w2 = own[2];
    const w3 = own[3];
    const key = MODELS[`${w2} ${w3}`]
      ? `${w2} ${w3}`
      : MODELS[w2]
        ? w2
        : w3 && MODELS[w3]
          ? w3
          : null;
    const make = key
      ? MODELS[key]
      : MAKES.includes(w2)
        ? w2 === 'chevy'
          ? 'Chevrolet'
          : w2 === 'vw'
            ? 'Volkswagen'
            : cap(w2)
        : undefined;
    // The customer's OWN car needn't be in our shopping vocabulary ("my 2019 Dodge Journey").
    const model = key
      ? displayModel(key)
      : make &&
          w3 &&
          /^[a-z][a-z0-9-]{1,15}$/.test(w3) &&
          !NAME_STOPWORDS.has(w3) &&
          ![
            'needs',
            'need',
            'is',
            'has',
            'with',
            'for',
            'and',
            'that',
          ].includes(w3)
        ? displayModel(w3)
        : undefined;
    if (make || model) {
      e.ownVehicle = {
        ...(own[1] ? { year: Number(own[1]) } : {}),
        ...(make ? { make } : {}),
        ...(model ? { model } : {}),
      };
      tShop = tShop.replace(own[0], ' ');
    }
  }

  // ── desired vehicle
  const veh: NonNullable<TurnEntities['vehicle']> = {};
  for (const [model, make] of Object.entries(MODELS).sort(
    (a, b) => b[0].length - a[0].length,
  )) {
    const re = new RegExp(`\\b${model.replace(/[-]/g, '[- ]?')}s?\\b`);
    if (re.test(tShop)) {
      if (/^\d+$/.test(model) && !/\bram\b/.test(tShop)) continue;
      veh.model = displayModel(model);
      veh.make = make;
      break;
    }
  }
  // Other models named in the same message ("pathfinder or rogue?") — tried when the first has none.
  const alts: string[] = [];
  for (const m of Object.keys(MODELS).sort((a, b) => b.length - a.length)) {
    if (/^\d+$/.test(m)) continue;
    const re = new RegExp(`\\b${m.replace(/[-]/g, '[- ]?')}s?\\b`);
    const dm = displayModel(m);
    if (
      re.test(tShop) &&
      dm !== veh.model &&
      !alts.includes(dm) &&
      !(veh.model ?? '').toLowerCase().includes(m)
    )
      alts.push(dm);
  }
  for (const w of tShop.match(/[a-z0-9-]{5,}/g) ?? []) {
    const fm = fuzzyModel(w);
    if (
      fm &&
      displayModel(fm) !== veh.model &&
      !alts.includes(displayModel(fm))
    )
      alts.push(displayModel(fm));
  }
  if (!veh.model) {
    const fm = fuzzyModel(tShop);
    if (fm) {
      veh.model = displayModel(fm);
      veh.make = MODELS[fm];
    }
  }
  if (!veh.make) {
    const mk = MAKES.find((m) => new RegExp(`\\b${m}\\b`).test(tShop));
    if (mk)
      veh.make =
        mk === 'chevy' ? 'Chevrolet' : mk === 'vw' ? 'Volkswagen' : cap(mk);
  }
  const yr = /\b(20[0-3]\d|19[89]\d)\b/.exec(tShop);
  if (yr && (veh.model || veh.make)) veh.year = Number(yr[1]);
  const newer = /\b(20[0-3]\d)\s*(?:or newer|and newer|\+|or later)\b/.exec(
    tShop,
  );
  if (newer) {
    veh.yearMin = Number(newer[1]);
    delete veh.year;
  }
  const color = COLORS.find((c) => new RegExp(`\\b${c}\\b`).test(tShop));
  if (color) veh.color = COLOR_ES[color] ?? color;
  if (/\b(suvs?|crossovers?)\b/.test(tShop)) veh.bodyType = 'SUV';
  else if (/\b(trucks?|pickups?|camioneta)\b/.test(tShop))
    veh.bodyType = 'Truck';
  else if (/\bsedans?\b/.test(tShop)) veh.bodyType = 'Sedan';
  else if (/\b(minivans?|vans?)\b/.test(tShop)) veh.bodyType = 'Van';
  if (/\b(awd|all[- ]wheel)\b/.test(tShop)) veh.drivetrain = 'AWD';
  else if (/\b(4x4|4wd|four[- ]wheel)\b/.test(tShop)) veh.drivetrain = '4WD';
  if (/\b(certified|cpo)\b/.test(tShop)) veh.condition = 'certified';
  else if (/\b(used|pre-?owned|seminuevo|usado)\b/.test(tShop))
    veh.condition = 'used';
  else if (
    /\bbrand new\b|\bnew (?:car|truck|suv|one|jeep|ford|toyota|honda|[a-z]+ (?:wrangler|tacoma|accord|civic|f-150))\b|\b(nuevo|nueva)\b/.test(
      tShop,
    )
  )
    veh.condition = 'new';
  if (/\b(ev|electric|eléctrico)\b/.test(tShop)) veh.fuel = 'electric';
  else if (/\b(hybrid|híbrido|phev|4xe)\b/.test(tShop)) veh.fuel = 'hybrid';
  else if (/\bdiesel\b/.test(tShop)) veh.fuel = 'diesel';
  const mileageCap = /\bunder\s+(\d[\d,]*)\s*(k)?\s*miles\b/.exec(tShop);
  if (mileageCap)
    veh.maxMileage = moneyToNumber(mileageCap[1], mileageCap[2]) ?? undefined;
  const seats = /\b(seven|eight|7|8)[- ]?(?:seat(?:er|s)?|passenger)\b/.exec(
    tShop,
  );
  if (seats) veh.seatsMin = WORD_NUM[seats[1]] ?? Number(seats[1]);
  if (Object.keys(veh).length) e.vehicle = veh;
  if (veh.model && alts.length) e.alternativeModels = alts.slice(0, 2);
  // Answering "what vehicle are we servicing?" — that's the customer's own car.
  const shopping =
    /\b(inventory|in stock|show me|do you have|have any|got any|any (?:new|used)|for sale|buy|shopping|looking for|interested in|tienen|busco|quiero ver)\b/.test(
      t,
    ) || /\bshow\b.*\binventory\b/.test(t);
  if (
    (pending === 'service_vehicle' ||
      // Mid-service, a vehicle described like an owned one ("2019 Cherokee") is the service
      // vehicle; a bare model name ("Wrangler") is a new shopping question.
      (ctx.activeDepartment === 'service' &&
        (pending === 'service_need' ||
          pending === 'appointment_date' ||
          pending === 'appointment_time') &&
        !!veh.year)) &&
    (veh.make || veh.model) &&
    !shopping
  ) {
    e.ownVehicle = { year: veh.year, make: veh.make, model: veh.model };
    delete e.vehicle;
    add('SERVICE_APPOINTMENT', 0.88, 'answers service vehicle question');
  }
  const zip = /\b(\d{5})(?:-\d{4})?\b/.exec(raw);
  if (zip && (pending === 'otd_zip' || /\bzip\b/i.test(raw))) {
    e.zip = zip[1];
    if (pending === 'otd_zip')
      add('OTD_QUOTE', 0.9, 'answers registration zip');
  }

  // ── features
  const feats: string[] = [];
  for (const [canon, syns] of Object.entries(FEATURE_SYNONYMS)) {
    if (syns.some((s) => t.includes(s))) feats.push(canon);
  }
  if (feats.length) e.features = feats;

  // ── money
  const monthly =
    /\b(?:under|below|less than|max(?:imum)?|no more than|around|about|at most|stay under|keep it under|menos de)\s*\$?\s*(\d[\d,]*)\s*(?:\/\s*mo(?:nth)?|a month|per month|monthly|al mes|mensual)/.exec(
      t,
    ) ??
    /\$?\s*(\d[\d,]{1,5})\s*(?:\/\s*mo(?:nth)?|a month|per month|monthly|al mes)\b/.exec(
      t,
    );
  if (monthly) {
    const n = moneyToNumber(monthly[1]);
    if (n && n >= 50 && n <= 5000) e.maxMonthly = n;
  }
  if (!e.maxMonthly) {
    // "I want to stay under $700" — an amount this small can only be a monthly budget.
    const small =
      /\b(?:under|below|less than|no more than|at most|stay under|keep it under|max(?:imum)?|around)\s*\$\s*(\d[\d,]*)\b(?!\s*(?:k|grand|thousand))/.exec(
        t,
      );
    const n = small ? moneyToNumber(small[1]) : null;
    if (n && n >= 100 && n < 3000) e.maxMonthly = n;
  }
  const price =
    /\b(?:under|below|less than|max(?:imum)?|no more than|budget(?: is| of)?|around|up to|menos de)\s*\$?\s*(\d[\d,.]*)\s*(k|grand|thousand|mil)?\b(?!\s*(?:\/\s*mo|a month|per month|monthly|miles|mi\b|al mes))/.exec(
      tShop,
    );
  if (price) {
    const n = moneyToNumber(price[1], price[2]);
    if (n && n >= 1000 && n <= 500000 && n !== e.maxMonthly) e.maxPrice = n;
  }
  const down =
    /\$?\s*(\d[\d,.]*)\s*(k|grand|thousand|mil)?\s*(?:down|dollars down|as a down payment|de enganche|de inicial)\b/.exec(
      t,
    ) ??
    /\bdown payment (?:of|is)?\s*\$?\s*(\d[\d,.]*)\s*(k|grand|thousand)?/.exec(
      t,
    ) ??
    /\bput(?:ting)?\s*\$?\s*(\d[\d,.]*)\s*(k|grand|thousand)?\s*down\b/.exec(t);
  if (down) {
    const n = moneyToNumber(down[1], down[2]);
    if (n !== null && n >= 0 && n <= 200000) e.downPayment = n;
  }
  const term =
    /\b(24|36|48|60|72|84|96)\s*(?:months?|mos?|mo\b|meses)\b/.exec(t) ??
    /\b([2-8])\s*(?:years?|yrs?|años)\b(?=.*\b(loan|term|finance|financing|payment)\b)/.exec(
      t,
    );
  if (term)
    e.termMonths =
      Number(term[1]) < 12 ? Number(term[1]) * 12 : Number(term[1]);
  const apr =
    /\b(\d{1,2}(?:\.\d{1,2})?)\s*%\s*(?:apr|interest|rate)?|\b(?:apr|rate|interest)\s*(?:of|is|at)?\s*(\d{1,2}(?:\.\d{1,2})?)\s*%/.exec(
      t,
    );
  if (
    apr &&
    /\b(apr|rate|interest|%)/.test(t) &&
    !/\b(approved|approval)\b/.test(t)
  ) {
    const n = Number(apr[1] ?? apr[2]);
    if (n >= 0 && n <= 30) e.customerApr = n;
  }
  const cashBuyer =
    /\b(pay(?:ing)? (?:in |with )?cash|cash (?:buyer|deal|purchase|price)|(?:don'?t|do not|won'?t) (?:want|need) (?:financing|a loan|to finance)|not (?:financing|going to finance)|no financing|pay(?:ing)? (?:it )?(?:off )?in full|paying outright|de contado|en efectivo)\b/.test(
      t,
    );
  if (cashBuyer) e.leaseOrPurchase = 'cash';
  else if (/\blease|leasing|arrendamiento\b/.test(t))
    e.leaseOrPurchase = 'lease';
  else if (/\b(buy|purchase|finance it|financing|own it)\b/.test(t))
    e.leaseOrPurchase = 'purchase';
  // Short answers to "finance or cash?"
  if (pending === 'payment_method') {
    if (
      /^\s*(?:cash|all cash|cash please|efectivo|de contado)\s*[.!]*\s*$/.test(
        t,
      )
    ) {
      e.leaseOrPurchase = 'cash';
      add('OTD_QUOTE', 0.9, 'answers payment method: cash');
    } else if (/\b(financ\w*|loan|monthly|payments?)\b/.test(t)) {
      e.leaseOrPurchase = 'purchase';
      add('FINANCE_REQUEST', 0.9, 'answers payment method: finance');
    } else if (/\blease\b/.test(t)) {
      e.leaseOrPurchase = 'lease';
      add('FINANCE_REQUEST', 0.9, 'answers payment method: lease');
    }
  }

  // ── when
  const when = resolveWhen(raw, ctx.timeZone, ctx.now);
  if (when) e.when = when;

  // ── contact
  const contact = extractContact(raw, pending);
  if (contact) e.contact = contact;

  // ── ranking over shown vehicles
  const rk =
    /\b(?:the )?(?:(two|three|2|3|top two|top three) )?(nicest|best|most expensive|highest[- ]priced|priciest|loaded|top[- ]of[- ]the[- ]line|cheapest|least expensive|lowest[- ]priced|most affordable|newest|latest|lowest (?:miles|mileage)|least miles)\b/.exec(
      t,
    );
  if (rk) {
    const w = rk[2];
    const by = /cheap|least exp|lowest[- ]priced|affordable/.test(w)
      ? 'price_asc'
      : /newest|latest/.test(w)
        ? 'year_desc'
        : /miles|mileage/.test(w)
          ? 'miles_asc'
          : 'price_desc';
    const cnt = rk[1]
      ? (WORD_NUM[rk[1].replace('top ', '')] ??
        Number(rk[1].replace('top ', '')))
      : undefined;
    e.rank = { by, ...(cnt ? { count: cnt } : {}) };
    e.referencesPrior = true;
  }

  // ── references to prior results
  if (
    /\b(go(?:ing)? back to|back to the|return to|come back to|revisit|volvamos a)\b/.test(
      t,
    )
  )
    e.resume = true;
  if (
    /\b(you showed me|you sent|from before|the (?:first|second|third|last|other|[a-z]+) one|that one|this one|those|these|of those|of these|the one you|ese|esa|esos|esas|la primera|el primero|la segunda|el segundo|la última|el último)\b/.test(
      t,
    )
  ) {
    e.referencesPrior = true;
  }

  // ── sentiment
  let sentiment: Sentiment = 'neutral';
  if (
    /\b(pissed|angry|furious|ridiculous|unacceptable|nobody (?:is )?help|no one (?:is )?help|called (?:twice|three times|\d+ times|multiple times)|waste of (?:my )?time|terrible|worst|fed up|frustrat|annoyed|ignored|still waiting|never called back|wtf|molesto|enojado|keep dodging|dodg(?:e|ing) (?:my|the) question|not answering|you(?:'re| are) not listening|answer (?:my|the) question|didn'?t answer|useless)\b/.test(
      t,
    )
  )
    sentiment = 'frustrated';
  else if (
    /\b(worried|nervous|scared|afraid|not sure i can afford|bad credit|credit is bad|anxious|concerned|preocupad)\b/.test(
      t,
    )
  )
    sentiment = 'anxious';
  else if (
    /\b(awesome|love it|perfect|great, thanks|thank you so much|excellent)\b/.test(
      t,
    )
  )
    sentiment = 'positive';

  const social = classifySocial(raw);
  if (social.acts.length) {
    e.social = social.acts;
    e.socialStrength = social.strength;
  }

  const isQuestion =
    /\?\s*$/.test(raw) ||
    /^(what|which|how|when|where|who|why|do|does|is|are|can|could|would|will|cuál|cuál|qué|que|cómo|como|cuándo|dónde|tienen|hay)\b/i.test(
      raw,
    );

  // ── SAFETY: urgent vehicle-safety language gets safety-first handling (no diagnosis)
  if (
    /\b(smoke|on fire|fire|flames|smell(?:s|ing)? (?:gas|fuel)|fuel leak|brakes? (?:failed|failing|went out|don'?t work|not working|gave out)|no brakes|steering (?:locked|failed|went out)|(?:car|truck|engine) (?:died|stalled|shut off) (?:on|in) (?:the )?(?:highway|freeway|interstate|traffic)|airbag deployed|(?:i was|we were|i(?:'ve| have) been|just got) in an? (?:accident|crash)|(?:i|we) (?:just )?crashed)\b/.test(
      t,
    )
  ) {
    add('SAFETY_URGENT', 0.95, 'urgent safety language');
  }

  // ── HUMAN HANDOFF: "agent"/"person" only with request verbs; not "real estate agent", "personal"
  if (
    /\b(talk|speak|chat|connect|transfer|put)\s+(?:me\s+)?(?:to|with|through to|in touch with)\s+(?:a |an |the |someone|somebody|a real|real|live|an actual)?\s*(?:human|person|someone|somebody|agent|rep|representative|salesperson|sales person|manager|advisor|associate)\b/.test(
      t,
    ) ||
    (/\b(real person|live person|live agent|human please|a human|actual person|representative|hablar con (?:alguien|una persona|un asesor))\b/.test(
      t,
    ) &&
      // "are you a real person?" asks what the assistant is — answered honestly, not a transfer
      !/\b(are you|is this|am i (?:talking|chatting|speaking)|is there (?:an? )?(?:real |actual )?(?:human|person))\b/.test(
        t,
      )) ||
    /^\s*(agent|human|representative|operator)\s*[.!?]*\s*$/.test(t) ||
    /\b(call me|have someone (?:call|text|reach)|someone (?:call|contact) me)\b/.test(
      t,
    )
  ) {
    add('HUMAN_HANDOFF', 0.95, 'explicit human request');
  }
  if (
    sentiment === 'frustrated' &&
    /\b(nobody|no one|called|waiting|help|ignored|never)\b/.test(t)
  ) {
    add('COMPLAINT', 0.9, 'frustration + unresolved contact');
  }

  // ── HOURS: "open"/"close" only with time/status context ("close to", "open to" excluded)
  if (
    /\bwhen (?:is|are) (?:the |your )?(?:\w+ )?(?:office|store|department|dealership|showroom|service|parts|finance)(?: \w+)? open\b/.test(
      t,
    ) ||
    /\b(hours|horario|what time (?:do|does|are) you (?:open|close)|when (?:do|does|are) you (?:open|close)|are you open|is (?:the )?(?:store|dealership|service|parts)(?: department)? open|open (?:now|today|tomorrow|on (?:sunday|saturday|monday|tuesday|wednesday|thursday|friday)|late|until)|close (?:today|tonight|at)|closing time|what time.*close|where are you located|your address|directions|ubicaci[oó]n|direcci[oó]n|a qu[eé] hora (?:abren|cierran))\b/.test(
      t,
    )
  ) {
    add('HOURS_LOCATION', 0.92, 'hours/location phrase');
  }

  // ── PARTS: "filter" only with part context; "filter by" is a search refinement
  const partsCue =
    /\b(parts?|part number|part #|brake pads?|brakes|rotors?|oem|aftermarket|wiper blades?|oil filter|air filter|cabin filter|battery|alternator|spark plugs?|floor mats?|tires?|headlight bulb|repuestos?|refacci[oó]n|frenos)\b/.test(
      t,
    ) &&
    !/(?<!\b(?:oil|air|cabin|fuel) )\bfilter (?:by|for|to|them|those|results)\b/.test(
      t,
    );
  // Service work phrased with part words ("tire rotation", "brake inspection") is service.
  const servicePhrase =
    /\b(squeak\w*|grind\w*|rattl\w*|vibrat\w*|overheat\w*|look at it|take a look|service department|service appointment|oil change|tire rotation|rotate (?:my )?tires|alignment|tune[- ]?up|inspection|check engine|warning light|battery (?:test|check)|brake (?:inspection|service|job))\b/.test(
      t,
    );
  if (partsCue && !servicePhrase) {
    // "front brakes … how much" → parts AND (often) installed service; parts inquiry handles both
    add('PARTS_INQUIRY', e.partNumber ? 0.95 : 0.85, 'parts vocabulary');
    const pm =
      /\b(front brakes?|rear brakes?|brake pads?|rotors?|wiper blades?|oil filter|air filter|cabin filter|battery|alternator|spark plugs?|floor mats?|tires?|headlight bulb)\b/.exec(
        t,
      );
    if (pm) e.partNeed = pm[1];
  }
  if (
    /\b(install(?:ed|ation)?|put (?:them|it) on|instalar)\b/.test(t) &&
    (partsCue || ctx.activeDepartment === 'parts')
  ) {
    add('SERVICE_APPOINTMENT', 0.7, 'installation request');
  }

  // ── SERVICE: "service" excluding "service contract/plan" (F&I product) and "customer service" complaints
  const serviceNeed =
    /\b(squeak\w*|grind\w*|rattl\w*|vibrat\w*|shak(?:e|ing)|pulls? to|pulling|overheat\w*|smok(?:e|ing)|takes? a look|look at it|oil change|cambio de aceite|tire rotation|rotate (?:my )?tires|alignment|inspection|state inspection|recall|check engine|warning light|maintenance|tune[- ]?up|repair|diagnos\w*|brake (?:job|service|inspection)|transmission (?:service|flush)|coolant|a\/?c (?:repair|service|not)|noise|leak|won'?t start|battery (?:test|replacement)|servicio|mantenimiento)\b/.exec(
      t,
    );
  const serviceDept =
    /\b(service (?:department|appointment|center|lane|advisor|visit|my|for|on)|get (?:it|my \w+) serviced|servicing|bring (?:it|my \w+) in|drop (?:it|my \w+) off|schedule (?:service|maintenance))\b/.test(
      t,
    ) && !/\b(service contract|service plan|customer service)\b/.test(t);
  if (serviceNeed || serviceDept) {
    if (serviceNeed) e.serviceNeed = serviceNeed[1];
    add(
      'SERVICE_APPOINTMENT',
      when || /\b(schedule|book|appointment|cita|come in|bring|drop)\b/.test(t)
        ? 0.9
        : 0.75,
      'service need',
    );
  }

  // ── AMENITIES
  const amen =
    /\b(shuttle|loaner|rental|courtesy car|ride ?share|uber|lyft|wifi|wi-fi|waiting area|wait for it)\b/.exec(
      t,
    );
  if (amen) {
    const a = amen[1];
    e.amenity = /shuttle/.test(a)
      ? 'shuttle'
      : /loaner|rental|courtesy/.test(a)
        ? 'loaner'
        : /ride|uber|lyft/.test(a)
          ? 'rideshare'
          : /wi/.test(a)
            ? 'wifi'
            : 'wait';
    add('SERVICE_AMENITY_QUESTION', 0.9, 'amenity question');
  }

  // ── RO / service status
  if (
    /\b(is my (?:car|truck|vehicle) (?:ready|done)|status of my (?:repair|car|vehicle|service)|repair order|ro status|when will my (?:car|truck) be ready)\b/.test(
      t,
    )
  ) {
    add('SERVICE_STATUS', 0.9, 'repair status ask');
  }

  // ── APPOINTMENT changes
  if (
    (/\b(reschedule|move (?:it|my appointment)|change (?:it|my appointment|the time|the day)|actually make it|make it (?:saturday|sunday|monday|tuesday|wednesday|thursday|friday|tomorrow|\d)|push it|cambiar (?:la )?cita)\b/.test(
      t,
    ) ||
      (/\binstead\b/.test(t) && !!when)) &&
    (ctx.hasActiveAppointment || when)
  ) {
    add(
      'APPOINTMENT_RESCHEDULE',
      ctx.hasActiveAppointment ? 0.93 : 0.6,
      'reschedule cue',
    );
  }
  if (
    /\b(cancel (?:it|my appointment|the appointment|appointment)|can'?t make it|won'?t make it|cancelar (?:la )?cita)\b/.test(
      t,
    )
  ) {
    add(
      'APPOINTMENT_CANCEL',
      ctx.hasActiveAppointment ? 0.93 : 0.6,
      'cancel cue',
    );
  }

  // ── SALES appointment / test drive: "appointment" alone is ambiguous → department decides
  const visitCue =
    /\b(test[- ]?drive|come (?:in|by|see|look)|stop by|swing by|visit|see it in person|can come|i can be there|come saturday|come sunday|prueba de manejo|pasar a verlo|puedo ir)\b/.test(
      t,
    );
  if (visitCue && !e.serviceNeed && !serviceDept) {
    add('SALES_APPOINTMENT', when ? 0.92 : 0.8, 'visit/test-drive cue');
  }
  if (
    /\b(appointment|schedule|book|cita|agendar)\b/.test(t) &&
    !intents.some((i) => /APPOINTMENT/.test(i.intent))
  ) {
    const dept = ctx.activeDepartment;
    if (dept === 'service' || e.serviceNeed)
      add('SERVICE_APPOINTMENT', 0.8, 'appointment in service context');
    else add('SALES_APPOINTMENT', 0.7, 'appointment in sales context');
  }
  if (when && !intents.some((i) => /APPOINTMENT/.test(i.intent))) {
    if (pending === 'appointment_date' || pending === 'appointment_time') {
      add(
        ctx.activeDepartment === 'service'
          ? 'SERVICE_APPOINTMENT'
          : 'SALES_APPOINTMENT',
        0.85,
        'answers pending date question',
      );
    } else if (
      /\b(i can|we can|i could|available|free|works for me|come|be there)\b/.test(
        t,
      )
    ) {
      add(
        ctx.activeDepartment === 'service'
          ? 'SERVICE_APPOINTMENT'
          : 'SALES_APPOINTMENT',
        0.75,
        'availability statement',
      );
    }
  }

  // ── FINANCE: "finance" alone can be a department question; credit app explicit
  if (
    /\b(credit app(?:lication)?s?|apply for (?:financing|credit|a loan|finance)|apply (?:for it )?online|get pre[- ]?approved|pre[- ]?approv\w*|pre[- ]?qualif\w*|finance application|financing application|loan application|(?:send|give|show) me (?:the |your |an? )?(?:credit |finance |financing |loan )?app(?:lication)?|(?:fill|filling) out (?:a |the |an |your )?(?:credit |finance |financing )?app(?:lication)?|where(?:'s| is) (?:the |your )(?:credit |finance |financing )?app(?:lication)?|solicitud de cr[eé]dito|aplicar para (?:el )?cr[eé]dito)\b/.test(
      t,
    ) ||
    /\b(?:get|getting) (?:pre-?)?financed\b|\b(?:finance|financing|credit|loan) app\b/.test(
      t,
    ) ||
    /\b(where (?:do|can) i apply|how (?:do|can) i apply|apply now|apply for (?:a |an )?(?:car )?loan)\b/.test(
      t,
    ) ||
    (ctx.creditOffered && /\b(do it online|online)\b/.test(t))
  ) {
    add('CREDIT_APPLICATION', 0.95, 'credit application');
  }
  if (
    !cashBuyer &&
    (/\b(financing|finance options|lease|leasing|loan|bad credit|credit score|monthly payment options|financiamiento|financiar)\b/.test(
      t,
    ) ||
      /\bcan i finance\b|\bfinance (?:it|this|that|one|the)\b/.test(t)) &&
    !/\bfinance (?:department|office) (?:hours|open)\b/.test(t)
  ) {
    add('FINANCE_REQUEST', 0.7, 'finance discussion');
  }
  if (
    /\b(am i approved|approve me|will i (?:get|be) (?:pre-?)?approved|can i get (?:pre-?)?approved|guarantee(?:d)? approval|what rate (?:will|would|do) i get|my rate|(?:i'?m|i am|i'?ll be|i will be|be) (?:pre[- ]?)?approved|mean (?:i'?m|i am) (?:pre[- ]?)?approved|instant(?:ly)? approv\w*)\b/.test(
      t,
    )
  ) {
    e.approvalQuestion = true;
    add('FINANCE_REQUEST', 0.85, 'approval/rate ask');
  }

  // ── OUT-THE-DOOR quote (cash or finance) — never requires a credit application
  if (
    /\btotal\b.{0,25}\b(?:tax|taxes|fees)\b/.test(t) ||
    /\bpay\b.{0,20}\b(?:with|after|including|plus) (?:tax|taxes|fees|title)\b/.test(
      t,
    ) ||
    /\b(out[- ]the[- ]door|out of the door|otd|drive[- ]?off|all[- ]in (?:price|cost|number)|total (?:price|cost)|final price|price (?:with|including) (?:tax|taxes|fees)|with (?:tax(?:es)?(?: and fees)?|fees) included|tax(?:es)? and fees included|precio final|precio total)\b/.test(
      t,
    ) ||
    (cashBuyer && (ctx.hasSelectedVehicle || ctx.hasVisibleVehicles))
  ) {
    add(
      'OTD_QUOTE',
      cashBuyer && !/out[- ]the[- ]door|otd/.test(t) ? 0.8 : 0.92,
      'out-the-door',
    );
  }

  // ── PAYMENT estimate
  if (
    e.maxMonthly ||
    e.downPayment !== undefined ||
    /\b(payments?|monthly|per month|a month|what would (?:it|that) (?:be|cost) (?:a|per) month|mensualidad|pago mensual|cu[aá]nto (?:ser[ií]a|pagar[ií]a) al mes)\b/.test(
      t,
    ) ||
    (e.termMonths && /\b(payments?|finance|loan)\b/.test(t)) ||
    (e.termMonths && ctx.hasSelectedVehicle) ||
    (ctx.hasPaymentEstimate &&
      (e.termMonths ||
        e.customerApr !== undefined ||
        (/\b(with my trade|what (?:would|does) (?:that|it) look like|what if|how about|what about)\b/.test(
          t,
        ) &&
          // "what if I come tomorrow at 5" is about a visit, not the payment
          !when &&
          !/\b(come|visit|stop by|swing by|test[- ]?drive|appointment|service|oil change)\b/.test(
            t,
          ))))
  ) {
    add(
      'PAYMENT_ESTIMATE',
      /\b(what|how much|cu[aá]nto)\b/.test(t) || e.downPayment !== undefined
        ? 0.9
        : 0.75,
      'payment terms',
    );
  }

  // ── HOLD: "hold on / hold up" are filler, not reservations
  if (
    /\b(hold (?:it|this|that|the|one|a)(?! on)\b|put (?:it|this|that) on hold|reserve (?:it|this|that|the)|deposit on|apartar(?:lo|la)?)\b/.test(
      t,
    ) &&
    !/\bhold (?:on|up)\b/.test(t)
  ) {
    add('HOLD_REQUEST', 0.85, 'reservation request');
  }

  // ── COMPARE
  if (
    /\b(compare|comparison|side by side|difference between|versus|vs\.?|which is better|comparar)\b/.test(
      t,
    )
  ) {
    if (GENERAL_TOPIC.test(t) && !e.vehicle?.model && !e.vehicle?.make)
      add('KNOWLEDGE_QUESTION', 0.85, 'general automotive comparison');
    else add('COMPARE', 0.85, 'compare cue');
  }

  // ── selection of prior vehicle
  if (
    e.referencesPrior &&
    (ctx.hasVisibleVehicles || ctx.hasSelectedVehicle) &&
    /\b(want|like|take|interested|go with|choose|that one|this one|the \w+ one|quiero|me gusta)\b/.test(
      t,
    )
  ) {
    add('SELECT_VEHICLE', 0.85, 'reference to shown vehicle');
  }
  if (e.vin) add('SELECT_VEHICLE', 0.9, 'vin provided');

  // ── features as a filter on prior results ("which of those has heated seats")
  if (e.features?.length) {
    if (
      (ctx.hasVisibleVehicles &&
        (e.referencesPrior ||
          /\b(which|any of|do any|does it|does this|tiene|tienen)\b/.test(
            t,
          ))) ||
      /\bwith\b/.test(t)
    ) {
      add(
        ctx.hasVisibleVehicles || ctx.hasSelectedVehicle
          ? 'FEATURE_FILTER'
          : 'INVENTORY_SEARCH',
        0.88,
        'feature constraint',
      );
    }
  }

  // ── INVENTORY search: "new"/"car" alone are not enough
  const shopVerb =
    /\b(looking for|shopping for|in the market for|want (?:a|an|to buy)|need (?:a|an) (?:new |used )?(?:car|truck|suv|vehicle|van|sedan)|show me|do you have|got any|any (?:\w+ )?(?:in stock|available)|in stock|inventory|busco|quiero (?:un|una)|tienen)\b/.test(
      tShop,
    );
  const hasVehicleSpec = !!(
    veh.model ||
    veh.make ||
    veh.bodyType ||
    veh.fuel ||
    veh.seatsMin
  );
  const shoppingSpec =
    hasVehicleSpec || !!e.maxPrice || !!veh.color || !!veh.condition;
  const selecting = intents.some((i) => i.intent === 'SELECT_VEHICLE');
  const browseMore =
    /\b(show me (?:what you(?:'ve| have)? got|what you have|them|those|some|options|more|everything|all)|what (?:do )?you (?:have|got)|what(?:'s| is) available|let me see (?:them|some|what)|see (?:them|some options)|what are my options)\b/.test(
      t,
    );
  // Mentioning a model already on screen ("I like that Wrangler", "back to the Wrangler")
  // refers to THAT vehicle — it must not trigger a brand-new search that drops it.
  const mentionsKnown =
    !!veh.model &&
    (ctx.knownModels ?? []).includes(veh.model.toLowerCase()) &&
    (e.resume ||
      /\b(that|this|the|those|these|like|love|want|take|interested in the|liked)\b/.test(
        tShop,
      )) &&
    !shopVerb;
  // "I like the Series II" — a trim of a vehicle on screen (longest match wins: II vs III).
  if (!mentionsKnown && ctx.knownTrims?.length && ctx.hasVisibleVehicles) {
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hit = [...ctx.knownTrims]
      .flatMap((tr) => {
        const w = tr.split(/\s+/);
        return [tr, w.slice(0, 2).join(' '), w[0]].filter((x) => x.length >= 3);
      })
      .sort((a, b) => b.length - a.length)
      .find((tr) => new RegExp(`\\b${esc(tr)}\\b`).test(t));
    if (hit && !/\b(compare|vs|versus)\b/.test(t)) {
      veh.trim = hit;
      e.vehicle = { ...veh };
      e.referencesPrior = true;
      add('SELECT_VEHICLE', 0.86, 'trim of shown vehicle');
    }
  }
  if (mentionsKnown) {
    add(
      'SELECT_VEHICLE',
      0.88,
      e.resume ? 'resume known vehicle' : 'known vehicle reference',
    );
    e.referencesPrior = true;
  }
  const trimSelected = intents.some(
    (i) => i.evidence === 'trim of shown vehicle',
  );
  if (
    !e.serviceNeed &&
    !partsCue &&
    !mentionsKnown &&
    !e.ownVehicle &&
    !trimSelected
  ) {
    if (browseMore && !shoppingSpec && ctx.hasCriteria)
      add('INVENTORY_SEARCH', 0.85, 'browse with saved criteria');
    else if (shopVerb && shoppingSpec)
      add('INVENTORY_SEARCH', 0.9, 'shopping verb + spec');
    else if (hasVehicleSpec && !selecting && !isQuestion)
      add('INVENTORY_SEARCH', 0.7, 'vehicle spec');
    else if (
      hasVehicleSpec &&
      !selecting &&
      isQuestion &&
      /\b(any|have|got|available|stock|show|see|inventory|options|look at|carry|lot|on hand)\b/.test(
        tShop,
      )
    )
      add('INVENTORY_SEARCH', 0.8, 'availability question');
    else if (e.maxPrice && !intents.length)
      add('INVENTORY_SEARCH', 0.65, 'budget only');
  }

  // ── VEHICLE question (about selected/visible vehicle)
  if (
    (ctx.hasSelectedVehicle || ctx.hasVisibleVehicles) &&
    isQuestion &&
    /\b(mileage|miles|color|engine|mpg|warranty|history|carfax|accident|features?|towing|tow capacity|trim|options|still available|is it available|sold)\b/.test(
      t,
    )
  ) {
    add('VEHICLE_QUESTION', 0.75, 'question about shown vehicle');
  }

  // ── TEXT continuation / SMS
  if (
    /\b(text me|continue by text|send (?:it|me) a text|by sms|textéame|mensaje de texto)\b/.test(
      t,
    )
  ) {
    add('TEXT_CONTINUATION', 0.9, 'text continuation');
  }

  // ── contact provided
  if (
    e.contact &&
    (e.contact.phone || e.contact.email || e.contact.firstName)
  ) {
    add(
      'PROVIDE_CONTACT',
      pending === 'contact_name' || pending === 'contact_method' ? 0.95 : 0.7,
      'contact details',
    );
  }

  // ── short replies
  if (
    /^\s*(yes|yeah|yep|yup|sure|ok|okay|please|please do|do it|sounds good|let'?s do it|s[ií]|claro|dale|perfect|that works|works for me)\s*[.!]*\s*$/.test(
      t,
    )
  )
    add('AFFIRM', 0.9, 'affirmative');
  if (
    /^\s*(no|nope|nah|not now|no thanks|no thank you|maybe later|not yet|no gracias|not interested|not really|i'?m (?:ok|okay|good|fine)(?: for now)?(?:,? thanks?)?|all good|we'?re good)\s*[.!]*\s*$/.test(
      t,
    ) &&
    (!/\bi'?m (?:ok|okay|good|fine)|all good|we'?re good/.test(t) ||
      (pending !== 'none' && pending !== undefined))
  )
    add('DECLINE', 0.9, 'negative');
  // Greetings are handled by the conversational layer (SMALL_TALK) below; GREETING is
  // reserved for department chips that open a conversation without text.

  // ── conversational layer: social acts never route to the dealership-fact fallback
  if (e.social?.length) {
    const pure = (e.socialStrength ?? 0) >= 0.6;
    if (
      e.social.includes('shopping_start') &&
      !intents.some((i) => i.intent === 'INVENTORY_SEARCH')
    )
      add('SHOPPING_START', 0.88, 'open shopping intent');
    if (
      e.social.includes('identity') ||
      e.social.includes('name_question') ||
      e.social.includes('origin_question')
    ) {
      add('SMALL_TALK', 0.95, 'identity question');
      // A question about who we are is never a handoff, a search or a knowledge lookup.
      for (let i = intents.length - 1; i >= 0; i -= 1)
        if (
          ['HUMAN_HANDOFF', 'KNOWLEDGE_QUESTION', 'INVENTORY_SEARCH'].includes(
            intents[i].intent,
          )
        )
          intents.splice(i, 1);
    } else if (
      e.social.some((a) => a !== 'shopping_start') &&
      (pure || !intents.length || e.social.includes('how_are_you'))
    )
      add('SMALL_TALK', pure ? 0.9 : 0.65, 'social act');
  }

  // A question that names a vehicle and asks nothing else is an availability question.
  if (
    !intents.length &&
    isQuestion &&
    hasVehicleSpec &&
    !e.ownVehicle &&
    !partsCue &&
    !e.serviceNeed &&
    // Product-information questions are not availability ("what's new with…", "is it reliable")
    !/\b(what'?s new|new with|difference|reliable|reliability|review|mpg|mileage rating|specs?|horsepower|towing capacity|how (?:does|is|good)|good car|worth it|better than|vs\.?|versus|safety rating|recall)\b/.test(
      t,
    )
  )
    add('INVENTORY_SEARCH', 0.75, 'vehicle question');

  // ── knowledge / general automotive question
  if (!intents.length && isQuestion)
    add('KNOWLEDGE_QUESTION', 0.6, 'open question');
  if (
    /\b(warranty|return policy|policy|do you (?:accept|take|offer)|documentation fee|doc fee|financing for|do you ship|delivery|out of state)\b/.test(
      t,
    ) &&
    !intents.some((i) => i.intent === 'KNOWLEDGE_QUESTION')
  ) {
    add('KNOWLEDGE_QUESTION', 0.7, 'policy question');
  }

  if (!intents.length)
    intents.push({
      intent: 'UNKNOWN',
      confidence: 0.3,
      evidence: 'no rule matched',
    });

  const PRIORITY: TurnIntent[] = [
    'SAFETY_URGENT',
    'COMPLAINT',
    'HUMAN_HANDOFF',
    'APPOINTMENT_CANCEL',
    'APPOINTMENT_RESCHEDULE',
    'CHANGE_OF_MIND',
    'RESUME_VEHICLE',
    'PURCHASE_START',
    'CREDIT_APPLICATION',
    'SERVICE_STATUS',
    'SERVICE_AMENITY_QUESTION',
    'PARTS_INQUIRY',
    'SERVICE_APPOINTMENT',
    'TRADE_IN',
    'SELECT_VEHICLE',
    'FEATURE_FILTER',
    'INVENTORY_SEARCH',
    'COMPARE',
    'PAYMENT_ESTIMATE',
    'OTD_QUOTE',
    'FINANCE_REQUEST',
    'SALES_APPOINTMENT',
    'HOLD_REQUEST',
    'VEHICLE_QUESTION',
    'HOURS_LOCATION',
    'TEXT_CONTINUATION',
    'PROVIDE_CONTACT',
    'KNOWLEDGE_QUESTION',
    'LANGUAGE_SWITCH',
    'AFFIRM',
    'DECLINE',
    'SHOPPING_START',
    'SMALL_TALK',
    'GREETING',
    'UNKNOWN',
  ];
  // ── PURCHASE: "how do I buy it now", "take it home today", "what do I need to bring"
  const purchaseCue =
    /\b(?:how (?:do i |can i |would i |could i |to |do we )(?:buy|purchase|get|take home) (?:it|this|that|one|the \w+|a \w+)|buy (?:it|this|that|this one|that one|one|the \w+(?: \w+)?) (?:now|today|right now|asap|this week)|(?:can|could) i (?:buy|purchase) (?:it|this|that|one)|i(?:'?d| would)? (?:like|want) to (?:buy|purchase) (?:it|this|that|one|the)|i(?:'?m| am) ready to (?:buy|purchase|sign|do this|move forward|make a deal)|ready to (?:buy|purchase)|take (?:it|this|her|him|this one) home|drive (?:it|this|her|this one) home|get (?:this|it) done|make (?:this|it) happen|let'?s do (?:it|this|the deal)|i'?ll take it|i want it|sign (?:the papers|today|tonight)|close the deal|start the (?:purchase|paperwork|buying process)|(?:quiero )?comprar(?:lo|la)|lo quiero|la quiero|c[oó]mo (?:lo|la) compro)\b/.test(
      t,
    );
  const bringQ =
    /\bwhat (?:do i|should i|do we|will i) (?:need to |have to )?bring\b|\bwhat (?:documents|paperwork|docs) (?:do i|will i|should i)\b|\bqu[eé] (?:necesito|tengo que) (?:traer|llevar)\b/.test(
      t,
    );
  if (bringQ) e.bringQuestion = true;
  if (purchaseCue || (bringQ && ctx.hasSelectedVehicle))
    add('PURCHASE_START', 0.93, 'purchase intent');
  else if (bringQ) add('PURCHASE_START', 0.8, 'documents question');
  if (
    /\bbefore (?:the |this )?weekend\b|\bby (?:friday|saturday|the weekend)\b/.test(
      t,
    ) &&
    (ctx.hasSelectedVehicle || purchaseCue) &&
    !intents.some((i) => /APPOINTMENT/.test(i.intent))
  )
    add('PURCHASE_START', 0.85, 'purchase timeline');

  // ── more OTD phrasings ("what's the damage after taxes", "how much all in")
  if (
    /\b(?:what'?s|what is) the damage\b|\bdamage after (?:tax|taxes|fees)\b|\bafter (?:tax|taxes)(?: and fees)?\b.{0,20}\b(?:price|cost|total|pay|damage|be)\b|\b(?:how much|what) (?:am i|would i be|will i be) (?:looking at|paying)(?: all in| total| in total)?\b(?=.*\b(?:tax|taxes|fees|all in|total|out)\b)|\ball in\b(?=.*\b(?:price|cost|how much|pay)\b)|\bhow much all in\b/.test(
      t,
    )
  )
    add('OTD_QUOTE', 0.9, 'out-the-door phrasing');

  // ── credit worries / "send me whatever application I need"
  if (
    /\b(?:my )?credit (?:isn'?t|is not|ain'?t|is) (?:great|good|the best|bad|poor|low|terrible|rough|not great|messed up)\b|\b(?:bad|poor|low|no|thin|rough|damaged|bruised) credit\b|\bbankruptcy\b|\brepo(?:ssession)?\b|\blittle (?:money )?down\b|\bno money down\b|\bzero down\b|\bmal cr[eé]dito\b|\bsin cr[eé]dito\b/.test(
      t,
    )
  ) {
    e.creditConcern = true;
    add('FINANCE_REQUEST', 0.88, 'credit concern');
  }
  if (
    /\b(?:send|give|get) me (?:whatever|the|any|all the|what) (?:application|apps?|forms?|paperwork)\b|\bwhat (?:application|forms?|paperwork) do i (?:need|fill)\b|\bwhere do i start\b(?=.*\b(?:financ|credit|loan|apply|application)\b)|\bcan i apply (?:now|today|online)\b|\bget approved before (?:coming|i come|i get there)\b/.test(
      t,
    )
  )
    add('CREDIT_APPLICATION', 0.92, 'application request');

  // ── loose visit times ("I'll come after work")
  const loose = /\bafter work\b/.test(t)
    ? 'after_work'
    : /\b(?:at |around |on my )?lunch(?: break)?\b/.test(t)
      ? 'lunch'
      : /\bin the (morning|afternoon|evening)\b|\bthis (morning|afternoon|evening)\b|\btomorrow (morning|afternoon|evening)\b/.exec(
          t,
        );
  if (loose) {
    e.looseTime =
      typeof loose === 'string'
        ? (loose as 'after_work' | 'lunch')
        : ((loose[1] ?? loose[2] ?? loose[3]) as
            | 'morning'
            | 'afternoon'
            | 'evening');
  }
  if (
    /\bi'?ll (?:come|stop|swing|drop|head|be there|be over|come by|come in)\b|\bi(?:'m| am) (?:coming|heading) (?:in|over|by)\b|\bcome (?:after work|by later|in later)\b/.test(
      t,
    ) &&
    !e.serviceNeed &&
    !intents.some((i) => /APPOINTMENT/.test(i.intent))
  )
    add(
      ctx.activeDepartment === 'service'
        ? 'SERVICE_APPOINTMENT'
        : 'SALES_APPOINTMENT',
      0.85,
      'visit statement',
    );

  // ── change of mind / "you're not answering"
  if (
    /\b(?:i )?changed my mind\b|\bnever ?mind\b|\bscratch that\b|\bforget (?:it|that|about it)\b|\bon second thought\b|\bcambi[eé] de opini[oó]n\b|\bolv[ií]dalo\b/.test(
      t,
    ) &&
    !e.vehicle?.model
  )
    add('CHANGE_OF_MIND', 0.9, 'change of mind');
  if (
    /\b(?:keep|kept) (?:dodging|avoiding|ignoring)\b|\bdodg(?:e|ing) (?:my|the) question\b|\bnot answering (?:my|the) question\b|\byou didn'?t answer\b|\banswer (?:my|the) question\b|\byou(?:'re| are) not listening\b|\bthat'?s not what i asked\b|\bno respondiste\b/.test(
      t,
    )
  )
    e.notAnswered = true;

  // ── "why should I buy this one?" is a question about the shown vehicle
  if (
    /\bwhy (?:should|would) i (?:buy|get|choose|pick|go with) (?:this|that|it|this one|that one)\b|\bwhat makes (?:it|this one|this) (?:special|worth it|stand out|better)\b|\bis (?:it|this one) worth it\b|\bsell me on (?:it|this)\b/.test(
      t,
    ) &&
    (ctx.hasSelectedVehicle || ctx.hasVisibleVehicles)
  )
    add('VEHICLE_QUESTION', 0.88, 'why this vehicle');

  // "morning" / "Friday" while we're collecting a booking is a time answer, not a greeting.
  if (
    (pending === 'appointment_date' || pending === 'appointment_time') &&
    e.when &&
    intents.some((i) => /APPOINTMENT/.test(i.intent))
  )
    for (let i = intents.length - 1; i >= 0; i -= 1)
      if (['GREETING', 'SMALL_TALK'].includes(intents[i].intent))
        intents.splice(i, 1);

  // "Let's go back to the Jeep" — return to the vehicle already being discussed.
  if (
    ctx.hasSelectedVehicle &&
    /\b(?:go|going|get|come|switch|head) back to (?:the |that |my |our )?(?:jeep|car|truck|suv|vehicle|one|it|\w+)\b|\bback to the (?:jeep|car|truck|suv|vehicle|\w+)\b|\bvolvamos (?:al|a la)\b/.test(
      t,
    )
  ) {
    add('RESUME_VEHICLE', 0.95, 'back to selected vehicle');
    for (let i = intents.length - 1; i >= 0; i -= 1)
      if (
        ['INVENTORY_SEARCH', 'SELECT_VEHICLE', 'KNOWLEDGE_QUESTION'].includes(
          intents[i].intent,
        )
      )
        intents.splice(i, 1);
  }

  // ── selected-vehicle facts: price and time on the lot
  const aboutShown = ctx.hasSelectedVehicle || ctx.hasVisibleVehicles;
  if (
    aboutShown &&
    /\b(?:how much (?:is|for|does|do|would|will)? ?(?:it|this|that|this one|that one|the \w+|they)?|what(?:'s| is| are) (?:the |its |your )?(?:price|asking price|sticker|cost)|price on (?:it|this|that)|how much)\b/.test(
      t,
    ) &&
    !/\b(month|monthly|payment|per mo|out[- ]the[- ]door|otd|tax|taxes|fees|all in|down|trade|apr|rate|insurance|oil change|service|repair|part)\b/.test(
      t,
    )
  ) {
    e.priceQuestion = true;
    add('VEHICLE_QUESTION', 0.9, 'price of selected vehicle');
  }
  if (
    /\bhow long (?:has|have|did) (?:it|this|that|the \w+|this (?:car|truck|suv|one)|that (?:car|truck|suv|one)|you(?:'ve)? had (?:it|this|that))\b.*\b(?:lot|stock|inventory|sitting|there|had)\b|\b(?:days|time) (?:on|in) (?:the |your )?(?:lot|stock|inventory)\b|\bhow long (?:has|have) (?:it|this|that)? ?been (?:on|in|at|sitting)\b|\bhow old is (?:the |this |that )?(?:listing|inventory)\b/.test(
      t,
    )
  ) {
    e.lotAgeQuestion = true;
    add('VEHICLE_QUESTION', 0.9, 'time on lot');
  }
  // ── "who is your manager?" — answer it; a callback is offered, not forced
  if (
    /\bwho(?:'s| is| are) (?:your |the )?(?:sales |service |general |finance )?(?:manager|managers|boss|owner|gm|person in charge)\b|\b(?:manager|gm|boss)'?s name\b|\bwho(?:'s| is) in charge\b|\bqui[eé]n es (?:el|su) (?:gerente|encargado)\b/.test(
      t,
    )
  ) {
    e.managerQuestion = true;
    add('KNOWLEDGE_QUESTION', 0.92, 'manager identity');
    for (let i = intents.length - 1; i >= 0; i -= 1)
      if (intents[i].intent === 'HUMAN_HANDOFF') intents.splice(i, 1);
  }
  // ── interest / short referring follow-ups
  if (
    /\b(?:i'?m|i am|am|yes|yeah|yep|very|super|definitely|really)?\s*(?:interested|intrested|intersted|interesed)\b/.test(
      t,
    )
  ) {
    e.interest = true;
    if (
      ctx.hasVisibleVehicles &&
      /\b(?:that one|this one|it|that|this|the one)\b/.test(t)
    )
      add('SELECT_VEHICLE', 0.88, 'interested in the shown vehicle');
    // "yes I'm interested" with nothing named = a yes to whatever was just asked
    if (
      !intents.some((i) => !['UNKNOWN', 'SMALL_TALK'].includes(i.intent)) &&
      !e.vehicle?.model
    )
      add('AFFIRM', 0.85, 'interested = yes');
  }
  if (
    /^\s*(?:what do you mean|meaning\?|huh\??|what\??|come again|i don'?t (?:get|understand)(?: it)?|qu[eé] quiere decir)\s*[?.!]*\s*$/.test(
      t,
    )
  )
    e.followUp = 'what_do_you_mean';
  else if (/^\s*(?:why|why\?|how come|por qu[eé])\s*[?.!]*\s*$/.test(t))
    e.followUp = 'why';
  else if (
    /^\s*(?:hold on|hang on|one (?:sec|second|moment|min(?:ute)?)|wait|give me a (?:sec|second|minute)|un momento)\b.{0,15}$/.test(
      t,
    )
  )
    e.followUp = 'hold_on';
  else if (
    /^\s*(?:show me|let me see|lemme see|show me (?:it|them|those|that)|let'?s see (?:it|them))\s*[!.]*\s*$/.test(
      t,
    )
  )
    e.followUp = 'show_me';
  else if (
    /^\s*(?:send it|send (?:it|that|me that) (?:over|please)?|go ahead and send it|yes send it)\s*[!.]*\s*$/.test(
      t,
    )
  )
    e.followUp = 'send_it';
  else if (
    /^\s*(?:that one|this one|the first one|the red one|yes that one|that one please)\s*[!.]*\s*$/.test(
      t,
    )
  )
    e.followUp = 'that_one';

  if (
    /^\s*(?:who(?:'s| is) that|who(?:'s| is) (?:he|she|they)|who would that be)\s*[?.!]*\s*$/.test(
      t,
    )
  )
    e.followUp = 'who_is_that';
  // Bare payment-method answers: "cash", "finance", "financing", "lease"
  if (/^\s*(?:cash|all cash|paying cash|cash buyer)\s*[.!]*\s*$/.test(t)) {
    e.leaseOrPurchase = 'cash';
    if (ctx.hasSelectedVehicle || ctx.hasVisibleVehicles)
      add('OTD_QUOTE', 0.85, 'bare cash answer');
  } else if (
    /^\s*(?:finance|financing|finance it|loan|lease|leasing)\s*[.!]*\s*$/.test(
      t,
    )
  ) {
    if (/lease/.test(t)) e.leaseOrPurchase = 'lease';
    add('FINANCE_REQUEST', 0.85, 'bare finance answer');
  }
  // "what about tomorrow?" / "how about Friday?" while shopping is a visit time
  if (
    e.when &&
    /^\s*(?:what|how) about\b/.test(t) &&
    (ctx.hasSelectedVehicle ||
      ctx.hasVisibleVehicles ||
      ctx.activeDepartment === 'sales' ||
      ctx.activeDepartment === 'service') &&
    !intents.some((i) => /APPOINTMENT/.test(i.intent))
  )
    add(
      ctx.activeDepartment === 'service'
        ? 'SERVICE_APPOINTMENT'
        : 'SALES_APPOINTMENT',
      0.82,
      'what about <day>',
    );

  // ── "how can I get started?" with a vehicle in view is a purchase start
  if (
    /\bhow (?:can|do) (?:i|we) (?:get started|start|begin)\b|\bwhat(?:'s| is| are) (?:the )?next steps?\b|\bwhere do (?:i|we) (?:start|begin)\b/.test(
      t,
    ) &&
    !intents.some((i) => i.intent === 'CREDIT_APPLICATION')
  )
    add(
      'PURCHASE_START',
      ctx.hasSelectedVehicle ? 0.9 : 0.8,
      'getting started',
    );

  // A generic "open question" fallback yields to any specific intent found above.
  if (intents.some((i) => i.evidence !== 'open question'))
    for (let i = intents.length - 1; i >= 0; i -= 1)
      if (intents[i].evidence === 'open question') intents.splice(i, 1);

  // ── CONTACT NUMBER question: answered from the store record, not a scheduling request.
  const phoneQ =
    !/\d{3}\D{0,3}\d{3}\D{0,3}\d{4}/.test(t) &&
    (/\b(?:what(?:'?s| is| are)|give me|can i (?:get|have)|do you have|need|send me|share)\b.{0,40}\b(?:phone(?: number)?s?|number to call|contact number|call(?:back)? number|tel[eé]fono)\b/.test(
      t,
    ) ||
      /\bhow (?:do|can|could) i (?:call|phone|reach|contact) (?:you|the|your|someone)\b/.test(
        t,
      ) ||
      /\b(?:phone|number) (?:for|to) (?:the |your )?(?:service|parts|sales|finance|store|dealership|call)\b/.test(
        t,
      ) ||
      /\bcu[aá]l es (?:el|su) (?:n[uú]mero|tel[eé]fono)\b/.test(t));
  if (phoneQ) {
    e.askPhone = true;
    add('HOURS_LOCATION', 0.95, 'contact phone question');
    if (!/\b(schedule|book|appointment|cita|come in|bring|drop)\b/.test(t))
      for (const x of [
        'SERVICE_APPOINTMENT',
        'SALES_APPOINTMENT',
        'PARTS_INQUIRY',
      ])
        for (let i = intents.length - 1; i >= 0; i -= 1)
          if (intents[i].intent === x) intents.splice(i, 1);
  }
  intents.sort(
    (a, b) => PRIORITY.indexOf(a.intent) - PRIORITY.indexOf(b.intent),
  );
  return {
    intents,
    primary: intents[0].intent,
    entities: e,
    sentiment,
    isQuestion,
  };
}

export function hasIntent(
  u: TurnUnderstanding,
  i: TurnIntent,
  min = 0.6,
): boolean {
  return u.intents.some((x) => x.intent === i && x.confidence >= min);
}
