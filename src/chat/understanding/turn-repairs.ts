/**
 * Narrow repairs for turns the main rules misread: a dollar figure with no role,
 * a trade versus the car being bought, a name that contains "weather", and
 * dealership-policy questions that should not fall through to "unavailable".
 */
import type { CustomerIncident } from '../safety/customer-incident';
import { classifyCustomerIncident } from '../safety/customer-incident';
import type {
  PendingQuestion,
  ScoredIntent,
  TurnEntities,
  TurnIntent,
} from './turn-understanding';

const EXOTIC =
  /\b(ferrari|porsche|lamborghini|maserati|bentley|rolls royce|mclaren|aston martin)\s+([a-z0-9-]+)\b/i;

export function applyTurnRepairs(args: {
  raw: string;
  normalized: string;
  pending: PendingQuestion;
  incidentActive?: boolean;
  incidentSeverity?: CustomerIncident['severity'];
  tradeOpen?: boolean;
  entities: TurnEntities;
  intents: ScoredIntent[];
}): void {
  const { entities: e, intents } = args;
  const t = args.normalized;
  const add = (intent: TurnIntent, confidence: number, evidence: string) => {
    const ex = intents.find((i) => i.intent === intent);
    if (ex) {
      if (confidence > ex.confidence) ex.evidence = evidence;
      ex.confidence = Math.max(ex.confidence, confidence);
      return;
    }
    intents.push({ intent, confidence, evidence });
  };
  const drop = (...names: TurnIntent[]) => {
    for (let i = intents.length - 1; i >= 0; i -= 1)
      if (names.includes(intents[i].intent)) intents.splice(i, 1);
  };

  const incident = classifyCustomerIncident(args.raw, {
    incidentActive: args.incidentActive,
    incidentSeverity: args.incidentSeverity,
  });
  if (incident) {
    e.incident = incident;
    add(
      incident.severity === 'danger' ? 'SAFETY_URGENT' : 'COMPLAINT',
      0.96,
      incident.safeNow
        ? 'customer says they are safe'
        : 'customer-reported incident',
    );
    if (!incident.safeNow)
      drop(
        'INVENTORY_SEARCH',
        'PAYMENT_ESTIMATE',
        'LIVE_INFO',
        'SALES_APPOINTMENT',
        'OTD_QUOTE',
        'PURCHASE_START',
      );
  }

  // "my name is weather man" is a name. Weather is a topic only when they ask.
  const nameIntro = /\b(?:my name is|my name's|this is|me llamo)\s+[a-z]/i.test(
    args.raw,
  );
  const asksWeather =
    /\b(?:forecast|temperature|rain|snow|how (?:cold|hot|warm)|clima|pron[oó]stico)\b/.test(
      t,
    );
  if (nameIntro && !asksWeather) drop('LIVE_INFO');

  // Bare "it's 24000" is a figure whose role is not yet known.
  // A price someone else allegedly promised ("the manager said I get it for $15,000")
  // is not a figure the customer is offering, and must not be repeated back.
  const attributedPrice = /\b(?:said|told me|promised|claims?)\b/.test(t);
  if (
    !attributedPrice &&
    e.downPayment === undefined &&
    e.maxPrice === undefined &&
    e.maxMonthly === undefined
  ) {
    const bare =
      /\b(?:it(?:'s| is)|its|that(?:'s| is)|priced at|price is|for)\s+\$?\s*(\d{1,3}(?:,\d{3})+|\d{4,6})\b/.exec(
        t,
      );
    if (bare) {
      const n = Number(bare[1].replace(/,/g, ''));
      if (n >= 1000 && n <= 500000) {
        e.statedAmount = n;
        e.statedAmountRole = /\b(?:down|down payment|enganche)\b/.test(t)
          ? 'down'
          : /\b(?:out-the-door|otd|all in)\b/.test(t)
            ? 'otd'
            : /\bprice\b/.test(t)
              ? 'price'
              : 'unclear';
        add('OTD_QUOTE', 0.9, 'stated dollar figure');
        drop('INVENTORY_SEARCH', 'PAYMENT_ESTIMATE');
      }
    }
  }
  if (
    args.pending === 'figure_meaning' &&
    /^\s*(?:price|the price|selling price|sticker)\s*[.!?]*\s*$/.test(t)
  ) {
    e.statedAmountRole = 'price';
    add('OTD_QUOTE', 0.92, 'figure is a price');
    drop('INVENTORY_SEARCH', 'AFFIRM');
  }

  if (
    /\b(?:with (?:my |the )?tax(?:es)?|include[sd]? tax|tax(?:es)? included|before tax|plus tax|is this with (?:my |the )?tax)\b/.test(
      t,
    )
  ) {
    e.taxQuestion = true;
    add('OTD_QUOTE', 0.9, 'tax question');
  }

  if (
    /\b(?:i(?:'m| am)|im) (?:in|from)\s+chicago\b|\bi live in chicago\b|\bregister(?:ing|ed)? (?:it )?in chicago\b/.test(
      t,
    ) ||
    (args.pending === 'otd_zip' && /^\s*chicago\s*[.!?]*\s*$/.test(t.trim()))
  ) {
    e.registrationPlace = 'Chicago';
    add('OTD_QUOTE', 0.9, 'registration city');
    drop('LIVE_INFO', 'INVENTORY_SEARCH', 'HOURS_LOCATION');
  }

  if (/\bi have a trade\b|\bi(?:'ve| have) got a trade\b/.test(t))
    add('TRADE_IN', 0.9, 'has a trade');

  const tradeFor =
    /\btrade(?:\s+|-)?(?:in\s+)?for\s+(?:a |an |the )?(?:jeep\s+)?([a-z][a-z0-9-]+)\b/.exec(
      t,
    );
  if (tradeFor) {
    e.tradeTowardPurchase = true;
    add('TRADE_IN', 0.9, 'trade toward a purchase');
    // The object of "for" is the car they want to buy, never the trade itself.
    if (e.trade?.model && e.trade.model.toLowerCase() === tradeFor[1]) {
      e.trade = { ...e.trade, model: undefined, make: undefined };
    }
  }

  const exoticRaw = EXOTIC.exec(args.raw);
  const exotic =
    exoticRaw && !/^(worth|is|my|the|a|an|for|in|to)$/i.test(exoticRaw[2])
      ? exoticRaw
      : null;
  const worth =
    /\bhow much is my\b|\bwhat(?:'s| is) my\b.{0,40}\bworth\b|\bworth of my\b/.test(
      t,
    );
  if (
    exotic &&
    (args.tradeOpen ||
      args.pending === 'trade_vehicle' ||
      /\btrade\b/.test(t) ||
      /\bmy\b/.test(t))
  ) {
    e.trade = {
      ...e.trade,
      make:
        exotic[1].charAt(0).toUpperCase() + exotic[1].slice(1).toLowerCase(),
      model: exotic[2].toUpperCase(),
    };
    if (e.vehicle?.model?.toLowerCase() === 'ferrari') delete e.vehicle;
    add('TRADE_IN', 0.93, 'trade vehicle named');
    drop('INVENTORY_SEARCH', 'SELECT_VEHICLE', 'PAYMENT_ESTIMATE');
  }
  if (worth && (e.trade || args.tradeOpen || exotic || /\bmy\b/.test(t))) {
    e.tradeValuation = true;
    add('TRADE_IN', 0.94, 'trade valuation');
    drop(
      'INVENTORY_SEARCH',
      'PAYMENT_ESTIMATE',
      'VEHICLE_QUESTION',
      'OTD_QUOTE',
    );
  }

  if (
    /\b(?:doc(?:umentation)? fee|dealer fee|documentation charge|what fees|which fees)\b/.test(
      t,
    )
  )
    e.policyTopic = 'fees';
  else if (
    /\b(?:optional package|add-?ons?|packages?|can i (?:decline|remove|delete) (?:the |that |an? )?)/.test(
      t,
    ) &&
    /\b(?:package|add-?on|option|tow package|decline|remove)\b/.test(t)
  )
    e.policyTopic = 'packages';
  else if (
    /\bwalk[- ]?ins?\b|\bwithout an appointment\b|\bjust (?:show up|come in|stop by)\b/.test(
      t,
    )
  )
    e.policyTopic = 'walk_in';
  else if (/\b(?:reviews?|google rating|yelp|stars|rated)\b/.test(t))
    e.policyTopic = 'reviews';
  else if (
    /\b(?:online|internet|advertised|website) price\b/.test(t) &&
    /\b(?:financ\w*|only if|require|cash)\b/.test(t)
  )
    e.policyTopic = 'price_financing';
  else if (
    /\b(?:pay(?:ing)? cash|cash (?:buyer|purchase|deal)|cash instead)\b/.test(
      t,
    ) &&
    /\b(?:allowed|eligible|can i|do you take|accept|instead of financ|versus|vs\.?)\b/.test(
      t,
    )
  )
    e.policyTopic = 'cash_vs_finance';
  else if (
    /\bwhat(?:'s| is| does)\b.{0,30}\b(?:out-the-door|out the door|otd)\b.{0,24}\b(?:mean|include|stand for)\b|\b(?:out-the-door|otd)\b.{0,16}\b(?:mean|include)\b/.test(
      t,
    )
  )
    e.policyTopic = 'otd_meaning';

  if (e.policyTopic) {
    add('KNOWLEDGE_QUESTION', 0.93, `policy:${e.policyTopic}`);
    drop('INVENTORY_SEARCH', 'PAYMENT_ESTIMATE', 'FINANCE_REQUEST');
    if (e.policyTopic === 'otd_meaning') drop('OTD_QUOTE');
  }

  if (
    /\b(?:what about |how about )?leas(?:e|ing) (?:it|this|that|one|the)\b|\blease payment\b|\bmonthly lease\b/.test(
      t,
    )
  ) {
    e.leaseOrPurchase = 'lease';
    add('PAYMENT_ESTIMATE', 0.9, 'lease payment');
    drop('FINANCE_REQUEST');
  }

  if (
    /\bi (?:still )?want to (?:buy|purchase) (?:it|this|that|the|one)\b/.test(t)
  )
    add('PURCHASE_START', 0.93, 'purchase intent');

  if (intents.some((i) => i.intent !== 'UNKNOWN')) drop('UNKNOWN');
  if (!intents.length)
    intents.push({
      intent: 'UNKNOWN',
      confidence: 0.3,
      evidence: 'no rule matched',
    });
}
