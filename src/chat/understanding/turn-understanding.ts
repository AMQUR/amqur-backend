import { resolveWhen, ResolvedWhen } from '../../common/time/date-phrase';
import {
  detectCreditSensitive,
  SensitiveKind,
} from '../../common/security/sensitive-data';

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
  | 'UNKNOWN';

export type Sentiment = 'neutral' | 'frustrated' | 'anxious' | 'positive';

export type TurnEntities = {
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
  leaseOrPurchase?: 'lease' | 'purchase';
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
  | 'text_consent';

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
  ...Object.keys(MODELS),
  ...MAKES,
]);

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
    if (!verbish.test(first) && !NAME_STOPWORDS.has(first.toLowerCase())) {
      out.firstName = cap(first);
      if (
        last &&
        !verbish.test(last) &&
        !NAME_STOPWORDS.has(last.toLowerCase())
      )
        out.lastName = cap(last);
    }
  } else if (pending === 'contact_name') {
    // Only treat a bare short reply as a name when we just asked for one.
    const clean = text.trim().replace(/[.!]+$/, '');
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
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

export function detectLanguage(text: string): 'en' | 'es' | undefined {
  const t = ` ${text.toLowerCase().replace(/[.,!?;:()]/g, ' ')} `;
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
  if (sEn >= 2 && sEn > sEs) return 'en';
  return undefined;
}

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
  },
): TurnUnderstanding {
  const raw = message.trim();
  const t = ` ${raw.toLowerCase().replace(/[“”]/g, '"').replace(/[’]/g, "'")} `;
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

  const tShop = tradeSpan ? t.replace(tradeSpan, ' ') : t;

  // ── desired vehicle
  const veh: NonNullable<TurnEntities['vehicle']> = {};
  for (const [model, make] of Object.entries(MODELS).sort(
    (a, b) => b[0].length - a[0].length,
  )) {
    const re = new RegExp(`\\b${model.replace(/[-]/g, '[- ]?')}s?\\b`);
    if (re.test(tShop)) {
      if (/^\d+$/.test(model) && !/\bram\b/.test(tShop)) continue;
      veh.model = model
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .replace('Cr-V', 'CR-V')
        .replace('F150', 'F-150');
      veh.make = make;
      break;
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
  if (/\blease|leasing|arrendamiento\b/.test(t)) e.leaseOrPurchase = 'lease';
  else if (/\b(buy|purchase|finance it|financing|own it)\b/.test(t))
    e.leaseOrPurchase = 'purchase';

  // ── when
  const when = resolveWhen(raw, ctx.timeZone, ctx.now);
  if (when) e.when = when;

  // ── contact
  const contact = extractContact(raw, pending);
  if (contact) e.contact = contact;

  // ── references to prior results
  if (
    /\b(you showed me|you sent|from before|the (?:first|second|third|last|other) one|that one|this one|those|these|of those|of these|the one you|ese|esa|esos|esas|la primera|el primero|la segunda|el segundo|la última|el último)\b/.test(
      t,
    )
  ) {
    e.referencesPrior = true;
  }

  // ── sentiment
  let sentiment: Sentiment = 'neutral';
  if (
    /\b(pissed|angry|furious|ridiculous|unacceptable|nobody (?:is )?help|no one (?:is )?help|called (?:twice|three times|\d+ times|multiple times)|waste of (?:my )?time|terrible|worst|fed up|frustrat|annoyed|ignored|still waiting|never called back|wtf|molesto|enojado)\b/.test(
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

  const isQuestion =
    /\?\s*$/.test(raw) ||
    /^(what|which|how|when|where|who|why|do|does|is|are|can|could|would|will|cuál|cuál|qué|que|cómo|como|cuándo|dónde|tienen|hay)\b/i.test(
      raw,
    );

  // ── HUMAN HANDOFF: "agent"/"person" only with request verbs; not "real estate agent", "personal"
  if (
    /\b(talk|speak|chat|connect|transfer)\s+(?:to|with)\s+(?:a |an |the |someone|somebody|a real|real|live|an actual)?\s*(?:human|person|someone|somebody|agent|rep|representative|salesperson|sales person|manager|advisor|associate)\b/.test(
      t,
    ) ||
    /\b(real person|live person|live agent|human please|a human|actual person|representative|hablar con (?:alguien|una persona|un asesor))\b/.test(
      t,
    ) ||
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
  if (
    partsCue &&
    !/\b(service department|service appointment|oil change)\b/.test(t)
  ) {
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
    /\b(oil change|cambio de aceite|tire rotation|rotate (?:my )?tires|alignment|inspection|state inspection|recall|check engine|warning light|maintenance|tune[- ]?up|repair|diagnos\w*|brake (?:job|service|inspection)|transmission (?:service|flush)|coolant|a\/?c (?:repair|service|not)|noise|leak|won'?t start|battery (?:test|replacement)|servicio|mantenimiento)\b/.exec(
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
    /\b(reschedule|move (?:it|my appointment)|change (?:it|my appointment|the time|the day)|actually make it|make it (?:saturday|sunday|monday|tuesday|wednesday|thursday|friday|tomorrow|\d)|instead|push it|cambiar (?:la )?cita)\b/.test(
      t,
    ) &&
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
    /\b(credit app(?:lication)?|apply for (?:financing|credit|a loan)|get pre-?approved|pre-?approval|pre-?qualif\w*|solicitud de cr[eé]dito|aplicar para (?:el )?cr[eé]dito)\b/.test(
      t,
    )
  ) {
    add('CREDIT_APPLICATION', 0.95, 'credit application');
  }
  if (
    /\b(financing|finance options|lease|leasing|loan|bad credit|credit score|monthly payment options|financiamiento|financiar)\b/.test(
      t,
    ) &&
    !/\bfinance (?:department|office) (?:hours|open)\b/.test(t)
  ) {
    add('FINANCE_REQUEST', 0.7, 'finance discussion');
  }
  if (
    /\b(am i approved|approve me|guarantee(?:d)? approval|what rate (?:will|would|do) i get|my rate)\b/.test(
      t,
    )
  ) {
    add('FINANCE_REQUEST', 0.85, 'approval/rate ask');
  }

  // ── PAYMENT estimate
  if (
    e.maxMonthly ||
    e.downPayment !== undefined ||
    /\b(payment|monthly|per month|a month|what would (?:it|that) (?:be|cost) (?:a|per) month|mensualidad|pago mensual|cu[aá]nto (?:ser[ií]a|pagar[ií]a) al mes)\b/.test(
      t,
    ) ||
    (e.termMonths && /\b(payment|finance|loan)\b/.test(t))
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
    add('COMPARE', 0.85, 'compare cue');
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
  if (!e.serviceNeed && !partsCue) {
    if (shopVerb && shoppingSpec)
      add('INVENTORY_SEARCH', 0.9, 'shopping verb + spec');
    else if (hasVehicleSpec && !selecting && !isQuestion)
      add('INVENTORY_SEARCH', 0.7, 'vehicle spec');
    else if (
      hasVehicleSpec &&
      !selecting &&
      isQuestion &&
      /\b(any|have|got|available|stock)\b/.test(tShop)
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
    /^\s*(no|nope|nah|not now|no thanks|no thank you|maybe later|not yet|no gracias)\s*[.!]*\s*$/.test(
      t,
    )
  )
    add('DECLINE', 0.9, 'negative');
  if (
    /^\s*(hi|hello|hey|hola|good (?:morning|afternoon|evening)|buenas)\b/.test(
      t,
    ) &&
    raw.split(/\s+/).length <= 4
  )
    add('GREETING', 0.8, 'greeting');

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
    'COMPLAINT',
    'HUMAN_HANDOFF',
    'APPOINTMENT_CANCEL',
    'APPOINTMENT_RESCHEDULE',
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
    'GREETING',
    'UNKNOWN',
  ];
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
