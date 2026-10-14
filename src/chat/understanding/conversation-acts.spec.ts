import { understandTurn, TurnIntent } from './turn-understanding';
import { classifySocial } from '../dialogue/social';

const tz = 'America/Chicago';
const u = (
  m: string,
  ctx: Partial<Parameters<typeof understandTurn>[1]> = {},
) => understandTurn(m, { timeZone: tz, ...ctx });
const has = (m: string, i: TurnIntent, ctx = {}) =>
  u(m, ctx).intents.some((x) => x.intent === i);

describe('conversational layer (real failed transcript)', () => {
  it.each([
    'Hey',
    'Hi',
    'hello!',
    'How are you',
    'How are you?',
    'how r u',
    "how's your day going?",
    'Pretty good, you?',
    "I'm doing well.",
    'thanks!',
    'Are you a real person?',
    "I'm just looking around.",
  ])('"%s" is SMALL_TALK and never a dealership-fact question', (m) => {
    const r = u(m);
    expect(r.primary).toBe('SMALL_TALK');
    expect(r.intents.map((i) => i.intent)).not.toContain('KNOWLEDGE_QUESTION');
  });

  it('classifies the social act precisely', () => {
    expect(classifySocial('How are you?').acts).toContain('how_are_you');
    expect(classifySocial('Pretty good, you?').acts).toContain(
      'reply_wellbeing_ask_back',
    );
    expect(classifySocial("I'm doing well.").acts).toContain('reply_wellbeing');
    expect(classifySocial('are you a bot').acts).toContain('identity');
    expect(classifySocial('just browsing').acts).toContain('browsing');
  });

  it('"I want to buy a car" starts discovery instead of a capability menu', () => {
    expect(u('I want to buy a car').primary).toBe('SHOPPING_START');
    expect(u("I'm looking for a car.").primary).toBe('SHOPPING_START');
  });

  it('a greeting attached to a real request keeps the request primary', () => {
    const r = u('Hi, do you have any Wranglers?');
    expect(r.primary).toBe('INVENTORY_SEARCH');
  });

  it('a model name searches inventory', () => {
    expect(u('Wrangler').primary).toBe('INVENTORY_SEARCH');
    expect(
      u('Can you show my Compass inventory?').intents.map((i) => i.intent),
    ).toContain('INVENTORY_SEARCH');
    expect(
      u("I've been thinking about a Grand Wagoneer.").entities.vehicle?.model,
    ).toBe('Grand Wagoneer');
  });

  it('dealership-specific questions still go to verified paths', () => {
    expect(u('Do you have a 2024 Wrangler in stock?').primary).toBe(
      'INVENTORY_SEARCH',
    );
    expect(u('What time do you close today?').primary).toBe('HOURS_LOCATION');
    expect(u('What is your doc fee?').primary).toBe('KNOWLEDGE_QUESTION');
  });
});

describe('sales journey understanding', () => {
  it('show me what you have uses saved criteria', () => {
    expect(
      has("Show me what you've got.", 'INVENTORY_SEARCH', {
        hasCriteria: true,
      }),
    ).toBe(true);
  });

  it('ranks shown vehicles for comparison', () => {
    const r = u('Compare the two nicest ones.', { hasVisibleVehicles: true });
    expect(r.primary).toBe('COMPARE');
    expect(r.entities.rank).toEqual({ by: 'price_desc', count: 2 });
  });

  it('payment adjustments recalculate', () => {
    const ctx = { hasPaymentEstimate: true, hasSelectedVehicle: true };
    expect(has('What if I put $7,000 down?', 'PAYMENT_ESTIMATE', ctx)).toBe(
      true,
    );
    expect(u('What if I put $7,000 down?').entities.downPayment).toBe(7000);
    expect(has('Show me 60 months instead', 'PAYMENT_ESTIMATE', ctx)).toBe(
      true,
    );
    expect(has('What about 84 months?', 'PAYMENT_ESTIMATE', ctx)).toBe(true);
    expect(u('I want to stay under $700.', ctx).entities.maxMonthly).toBe(700);
    expect(
      has('What would that look like with my trade?', 'PAYMENT_ESTIMATE', ctx),
    ).toBe(true);
  });

  it('out-the-door is its own intent and cash never triggers financing', () => {
    expect(u("What's the out-the-door price?").primary).toBe('OTD_QUOTE');
    const cash = u("I don't want financing, I'm paying cash", {
      hasSelectedVehicle: true,
    });
    expect(cash.entities.leaseOrPurchase).toBe('cash');
    expect(cash.intents.map((i) => i.intent)).toContain('OTD_QUOTE');
    expect(cash.intents.map((i) => i.intent)).not.toContain('FINANCE_REQUEST');
    expect(cash.intents.map((i) => i.intent)).not.toContain(
      'CREDIT_APPLICATION',
    );
  });

  it.each([
    "Where's your credit application?",
    'Where is the credit application?',
    'Can I apply for financing?',
    'Send me the application.',
    'How do I get preapproved?',
    'Can I fill out a credit app?',
  ])('"%s" → CREDIT_APPLICATION', (m) => {
    expect(u(m).primary).toBe('CREDIT_APPLICATION');
  });

  it('"can I do it online" after the application was offered', () => {
    expect(u('Can I do it online?', { creditOffered: true }).primary).toBe(
      'CREDIT_APPLICATION',
    );
  });

  it('"Can I finance this Grand Wagoneer?" is a finance question', () => {
    expect(has('Can I finance this Grand Wagoneer?', 'FINANCE_REQUEST')).toBe(
      true,
    );
  });

  it('"Does that mean I\'m approved?" is an approval question', () => {
    const r = u("Does that mean I'm approved?");
    expect(r.entities.approvalQuestion).toBe(true);
    expect(r.intents.map((i) => i.intent)).toContain('FINANCE_REQUEST');
  });
});

describe('department switching keeps vehicles apart', () => {
  const ctx = { knownModels: ['wrangler'], hasVisibleVehicles: true };
  it('"I like that Wrangler" selects the shown Wrangler (no new search)', () => {
    const r = u('I like that Wrangler.', ctx);
    expect(r.primary).toBe('SELECT_VEHICLE');
    expect(r.intents.map((i) => i.intent)).not.toContain('INVENTORY_SEARCH');
  });
  it('"service for my other Jeep" is about the customer’s own vehicle', () => {
    const r = u('Actually, can you schedule service for my other Jeep?', ctx);
    expect(r.primary).toBe('SERVICE_APPOINTMENT');
    expect(r.entities.ownVehicle?.make).toBe('Jeep');
    expect(r.intents.map((i) => i.intent)).not.toContain('INVENTORY_SEARCH');
  });
  it('brake pads → parts', () => {
    expect(u('And I need brake pads.').primary).toBe('PARTS_INQUIRY');
  });
  it('"go back to the Wrangler" resumes it', () => {
    const r = u("Now let's go back to the Wrangler.", ctx);
    expect(r.primary).toBe('SELECT_VEHICLE');
    expect(r.entities.resume).toBe(true);
  });
  it('answering the service-vehicle question never becomes a shopping search', () => {
    const r = u('2019 Jeep Cherokee', { pending: 'service_vehicle' });
    expect(r.primary).toBe('SERVICE_APPOINTMENT');
    expect(r.entities.ownVehicle).toMatchObject({
      year: 2019,
      model: 'Cherokee',
    });
    expect(r.entities.vehicle).toBeUndefined();
  });
});

describe('negatives and typos', () => {
  it.each(['no', 'nope', 'not interested', 'no thanks'])(
    '"%s" declines',
    (m) => {
      expect(u(m).primary).toBe('DECLINE');
    },
  );
  it('"I\'m good" after an offer declines, but as small talk it is wellbeing', () => {
    expect(u("I'm good", { pending: 'confirm_handoff' }).primary).toBe(
      'DECLINE',
    );
    expect(u("I'm good").primary).toBe('SMALL_TALK');
  });
  it('typos still find the model', () => {
    expect(u('show me a wranglr').entities.vehicle?.model).toBe('Wrangler');
  });
});
