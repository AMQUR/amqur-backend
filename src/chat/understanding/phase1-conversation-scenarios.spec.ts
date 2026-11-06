/**
 * Phase 1 conversation suite — deterministic understanding regressions.
 * Broadens coverage toward ≥100 scenarios (mission acceptance: small talk,
 * specials, acknowledgments, departments, typos, handoff, endings, Truth Engine routes).
 */
import { understandTurn, TurnIntent } from './turn-understanding';
import { classifySocial } from '../dialogue/social';

const tz = 'America/Chicago';
const u = (
  m: string,
  ctx: Partial<Parameters<typeof understandTurn>[1]> = {},
) => understandTurn(m, { timeZone: tz, ...ctx });

type Case = {
  say: string;
  primary: TurnIntent;
  ctx?: Partial<Parameters<typeof understandTurn>[1]>;
  not?: TurnIntent[];
  tag: string;
};

const SCENARIOS: Case[] = [
  // — small talk / greetings / typos —
  { say: 'hey', primary: 'SMALL_TALK', tag: 'greeting' },
  { say: 'hi there', primary: 'SMALL_TALK', tag: 'greeting' },
  { say: 'hello!', primary: 'SMALL_TALK', tag: 'greeting' },
  { say: 'good morning', primary: 'SMALL_TALK', tag: 'greeting' },
  { say: 'how are you', primary: 'SMALL_TALK', tag: 'how-are-you' },
  { say: 'how are you?', primary: 'SMALL_TALK', tag: 'how-are-you' },
  { say: 'how r u', primary: 'SMALL_TALK', tag: 'how-are-you-slang' },
  { say: 'how are yu today', primary: 'SMALL_TALK', not: ['KNOWLEDGE_QUESTION'], tag: 'how-are-you-typo' },
  { say: "how's your day going?", primary: 'SMALL_TALK', tag: 'how-are-you-day' },
  { say: 'Pretty good, you?', primary: 'SMALL_TALK', tag: 'wellbeing-ask-back' },
  { say: "I'm doing well.", primary: 'SMALL_TALK', tag: 'wellbeing' },
  { say: 'thanks!', primary: 'SMALL_TALK', tag: 'thanks' },
  { say: 'thank you so much', primary: 'SMALL_TALK', tag: 'thanks' },
  { say: 'Are you a real person?', primary: 'SMALL_TALK', not: ['HUMAN_HANDOFF'], tag: 'identity' },
  { say: 'are you a bot', primary: 'SMALL_TALK', tag: 'identity' },
  { say: "I'm just looking around.", primary: 'SMALL_TALK', tag: 'browsing' },
  { say: 'just browsing', primary: 'SMALL_TALK', tag: 'browsing' },
  { say: "what's your name", primary: 'SMALL_TALK', tag: 'name' },
  { say: 'why are you texting me', primary: 'SMALL_TALK', tag: 'origin' },
  { say: 'bye', primary: 'SMALL_TALK', tag: 'farewell' },
  { say: 'talk later', primary: 'SMALL_TALK', tag: 'farewell' },
  { say: "that's all", primary: 'SMALL_TALK', tag: 'farewell' },
  { say: 'lol', primary: 'SMALL_TALK', tag: 'laughter' },
  { say: 'sorry typo', primary: 'SMALL_TALK', tag: 'apology' },
  { say: "you're helpful", primary: 'SMALL_TALK', tag: 'compliment' },

  // — acknowledgments (never fuzzy consent) —
  { say: 'yes', primary: 'AFFIRM', tag: 'affirm' },
  { say: 'yeah', primary: 'AFFIRM', tag: 'affirm' },
  { say: 'yep', primary: 'AFFIRM', tag: 'affirm' },
  { say: 'sure', primary: 'AFFIRM', tag: 'affirm' },
  { say: 'ok', primary: 'AFFIRM', tag: 'affirm' },
  { say: 'okay', primary: 'AFFIRM', tag: 'affirm' },
  { say: 'oAY', primary: 'AFFIRM', tag: 'affirm-typo' },
  { say: 'OKy', primary: 'AFFIRM', tag: 'affirm-typo' },
  { say: 'oky', primary: 'AFFIRM', tag: 'affirm-typo' },
  { say: 'oay', primary: 'AFFIRM', tag: 'affirm-typo' },
  { say: 'sounds good', primary: 'AFFIRM', tag: 'affirm' },
  { say: 'no', primary: 'DECLINE', tag: 'decline' },
  { say: 'nope', primary: 'DECLINE', tag: 'decline' },
  { say: 'not interested', primary: 'DECLINE', tag: 'decline' },
  { say: 'no thanks', primary: 'DECLINE', tag: 'decline' },
  { say: "I'm good", primary: 'SMALL_TALK', tag: 'wellbeing-vs-decline' },
  {
    say: "I'm good",
    primary: 'DECLINE',
    ctx: { pending: 'confirm_handoff' },
    tag: 'decline-after-offer',
  },

  // — current offers / specials —
  { say: 'what are the specials', primary: 'CURRENT_OFFERS', not: ['KNOWLEDGE_QUESTION'], tag: 'specials' },
  { say: 'any specials?', primary: 'CURRENT_OFFERS', tag: 'specials' },
  { say: 'current offers', primary: 'CURRENT_OFFERS', tag: 'specials' },
  { say: 'do you have any deals', primary: 'CURRENT_OFFERS', tag: 'specials' },
  { say: 'any promotions?', primary: 'CURRENT_OFFERS', tag: 'specials' },
  { say: 'what incentives do you have', primary: 'CURRENT_OFFERS', tag: 'specials' },
  { say: 'any rebates?', primary: 'CURRENT_OFFERS', tag: 'specials' },
  { say: "today's offers", primary: 'CURRENT_OFFERS', tag: 'specials' },

  // — inventory / vehicle —
  { say: 'Wrangler', primary: 'INVENTORY_SEARCH', tag: 'model' },
  { say: 'show me a wranglr', primary: 'INVENTORY_SEARCH', tag: 'model-typo' },
  { say: 'do you have any Wranglers?', primary: 'INVENTORY_SEARCH', tag: 'inventory' },
  { say: 'Hi, do you have any Wranglers?', primary: 'INVENTORY_SEARCH', tag: 'greeting+inventory' },
  { say: 'black Compass under 40k', primary: 'INVENTORY_SEARCH', tag: 'inventory-filters' },
  { say: 'qx60 in stock', primary: 'INVENTORY_SEARCH', tag: 'alphanumeric-model' },
  { say: 'q x 60 in stock', primary: 'INVENTORY_SEARCH', tag: 'voice-model' },
  { say: 'do u have a tahoo', primary: 'INVENTORY_SEARCH', tag: 'model-typo-2' },
  {
    say: "Show me what you've got.",
    primary: 'INVENTORY_SEARCH',
    ctx: { hasCriteria: true },
    tag: 'saved-criteria',
  },
  {
    say: 'I like that Wrangler',
    primary: 'SELECT_VEHICLE',
    ctx: { knownModels: ['wrangler'], hasVisibleVehicles: true },
    not: ['INVENTORY_SEARCH'],
    tag: 'select-shown',
  },
  {
    say: "Now let's go back to the Wrangler.",
    primary: 'SELECT_VEHICLE',
    ctx: { knownModels: ['wrangler'], hasVisibleVehicles: true },
    tag: 'resume-vehicle',
  },
  {
    say: 'Compare the two nicest ones.',
    primary: 'COMPARE',
    ctx: { hasVisibleVehicles: true },
    tag: 'compare',
  },

  // — payments / finance / OTD —
  {
    say: 'What if I put $7,000 down?',
    primary: 'PAYMENT_ESTIMATE',
    ctx: { hasPaymentEstimate: true, hasSelectedVehicle: true },
    tag: 'payment-adjust',
  },
  {
    say: 'Show me 60 months instead',
    primary: 'PAYMENT_ESTIMATE',
    ctx: { hasPaymentEstimate: true, hasSelectedVehicle: true },
    tag: 'term-adjust',
  },
  { say: "What's the out-the-door price?", primary: 'OTD_QUOTE', tag: 'otd' },
  {
    say: 'what will i actually pay with taxes and fees',
    primary: 'OTD_QUOTE',
    ctx: { hasSelectedVehicle: true },
    tag: 'otd-taxes',
  },
  { say: 'Can I finance this Grand Wagoneer?', primary: 'FINANCE_REQUEST', tag: 'finance' },
  { say: "Does that mean I'm approved?", primary: 'FINANCE_REQUEST', tag: 'approval-q' },
  { say: 'Where is the credit application?', primary: 'CREDIT_APPLICATION', tag: 'credit-app' },
  { say: 'Can I apply for financing?', primary: 'CREDIT_APPLICATION', tag: 'credit-app' },
  { say: 'How do I get preapproved?', primary: 'CREDIT_APPLICATION', tag: 'credit-app' },
  {
    say: 'Can I do it online?',
    primary: 'CREDIT_APPLICATION',
    ctx: { creditOffered: true },
    tag: 'credit-online',
  },
  {
    say: "I don't want financing, I'm paying cash",
    primary: 'OTD_QUOTE',
    ctx: { hasSelectedVehicle: true },
    not: ['FINANCE_REQUEST', 'CREDIT_APPLICATION'],
    tag: 'cash-buyer',
  },

  // — service / parts —
  { say: 'I need an oil change', primary: 'SERVICE_APPOINTMENT', tag: 'service' },
  { say: 'need a tire rotation', primary: 'SERVICE_APPOINTMENT', tag: 'service' },
  {
    say: 'Actually, can you schedule service for my other Jeep?',
    primary: 'SERVICE_APPOINTMENT',
    ctx: { knownModels: ['wrangler'], hasVisibleVehicles: true },
    not: ['INVENTORY_SEARCH'],
    tag: 'service-own-vehicle',
  },
  {
    say: '2019 Jeep Cherokee',
    primary: 'SERVICE_APPOINTMENT',
    ctx: { pending: 'service_vehicle' },
    tag: 'service-vehicle-answer',
  },
  { say: 'And I need brake pads.', primary: 'PARTS_INQUIRY', tag: 'parts' },
  { say: 'do you sell floor mats', primary: 'PARTS_INQUIRY', tag: 'parts' },

  // — hours / location / phone —
  { say: 'What time do you close today?', primary: 'HOURS_LOCATION', tag: 'hours' },
  { say: 'are you open on Sunday?', primary: 'HOURS_LOCATION', tag: 'hours' },
  { say: 'where are you located?', primary: 'HOURS_LOCATION', tag: 'location' },
  {
    say: "What's your service department's phone number?",
    primary: 'HOURS_LOCATION',
    tag: 'phone',
  },
  { say: 'how do i call you guys', primary: 'HOURS_LOCATION', tag: 'phone' },

  // — shopping / purchase / trade —
  { say: 'I want to buy a car', primary: 'SHOPPING_START', tag: 'shopping-start' },
  { say: "I'm looking for a car.", primary: 'SHOPPING_START', tag: 'shopping-start' },
  {
    say: "I'll take it",
    primary: 'PURCHASE_START',
    ctx: { hasSelectedVehicle: true },
    tag: 'purchase',
  },
  { say: 'I have a trade-in', primary: 'TRADE_IN', tag: 'trade' },
  { say: 'can I trade my 2018 Civic', primary: 'TRADE_IN', tag: 'trade' },

  // — handoff / complaint / safety —
  { say: 'connect me with a salesperson', primary: 'HUMAN_HANDOFF', tag: 'handoff' },
  { say: 'I want to talk to a manager', primary: 'HUMAN_HANDOFF', tag: 'handoff' },
  {
    say: 'this is ridiculous, nobody is helping me',
    primary: 'COMPLAINT',
    tag: 'complaint',
  },

  // — knowledge / policy / truth-engine routes —
  { say: 'What is your doc fee?', primary: 'KNOWLEDGE_QUESTION', tag: 'fees' },
  { say: 'do you ship out of state?', primary: 'KNOWLEDGE_QUESTION', tag: 'policy' },
  { say: "what's the catch", primary: 'KNOWLEDGE_QUESTION', tag: 'catch' },
  { say: 'what makes this special', primary: 'KNOWLEDGE_QUESTION', not: ['CURRENT_OFFERS'], tag: 'not-specials' },
  { say: "What's new with the 2027 Tacoma?", primary: 'KNOWLEDGE_QUESTION', not: ['INVENTORY_SEARCH'], tag: 'product-edu' },

  // — multilingual —
  { say: 'hola', primary: 'SMALL_TALK', tag: 'es-greeting' },
  { say: '¿Tienen Compass?', primary: 'INVENTORY_SEARCH', tag: 'es-inventory' },
  { say: 'gracias', primary: 'SMALL_TALK', tag: 'es-thanks' },

  // — multi-intent / corrections / references —
  {
    say: 'pathfinder or rouge?',
    primary: 'INVENTORY_SEARCH',
    tag: 'alt-models',
  },
  {
    say: 'the cheaper one',
    primary: 'SELECT_VEHICLE',
    ctx: { hasVisibleVehicles: true },
    tag: 'reference-cheaper',
  },
  {
    say: 'that one',
    primary: 'SELECT_VEHICLE',
    ctx: { hasVisibleVehicles: true, hasSelectedVehicle: false },
    tag: 'reference-that-one',
  },

  // — appointments —
  { say: 'I want a test drive Saturday', primary: 'SALES_APPOINTMENT', tag: 'test-drive' },
  { say: 'schedule a visit', primary: 'SALES_APPOINTMENT', tag: 'visit' },
  { say: 'cancel my appointment', primary: 'APPOINTMENT_CANCEL', tag: 'cancel' },
  {
    say: 'move my appointment to Saturday',
    primary: 'APPOINTMENT_RESCHEDULE',
    ctx: { hasActiveAppointment: true },
    tag: 'reschedule',
  },

  // — hold / text —
  {
    say: 'can you hold it for me',
    primary: 'HOLD_REQUEST',
    ctx: { hasSelectedVehicle: true },
    tag: 'hold',
  },
  { say: 'text me instead', primary: 'TEXT_CONTINUATION', tag: 'sms' },

  // — more typo / slang coverage —
  { say: 'whats the paymnet on that', primary: 'PAYMENT_ESTIMATE', ctx: { hasSelectedVehicle: true }, tag: 'payment-typo' },
  { say: 'can i shedule service', primary: 'SERVICE_APPOINTMENT', tag: 'schedule-typo' },
  { say: 'how can i get pre approved', primary: 'CREDIT_APPLICATION', tag: 'preapprove-space' },
  { say: 'wranglers on the lot?', primary: 'INVENTORY_SEARCH', tag: 'lot-availability' },
  { say: 'am i chatting with a robot', primary: 'SMALL_TALK', not: ['HUMAN_HANDOFF'], tag: 'identity-2' },
  { say: 'is there a human on the other end', primary: 'SMALL_TALK', not: ['HUMAN_HANDOFF'], tag: 'identity-3' },
];

describe('Phase 1 conversation scenarios (≥100)', () => {
  it(`suite size is at least 100 (have ${SCENARIOS.length})`, () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(100);
  });

  it.each(SCENARIOS.map((c) => [c.tag, c.say, c] as const))(
    '%s — "%s"',
    (_tag, _say, c) => {
      const r = u(c.say, c.ctx ?? {});
      expect(r.primary).toBe(c.primary);
      for (const banned of c.not ?? []) {
        expect(r.intents.map((i) => i.intent)).not.toContain(banned);
      }
    },
  );

  it('social classifier still tags how-are-you typos', () => {
    expect(classifySocial('how are yu today').acts).toContain('how_are_you');
  });
});
