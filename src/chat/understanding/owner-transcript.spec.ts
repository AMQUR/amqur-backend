import { understandTurn, TurnIntent } from './turn-understanding';

const u = (
  m: string,
  ctx: Partial<Parameters<typeof understandTurn>[1]> = {},
) =>
  understandTurn(m, {
    timeZone: 'America/Chicago',
    hasSelectedVehicle: true,
    ...ctx,
  });

/** Owner transcript (2026-10-14) and the unscripted phrasings from the owner brief. */
describe('owner transcript + unscripted phrasings', () => {
  it.each<[string, TurnIntent]>([
    ['How to buy it now?', 'PURCHASE_START'],
    ['How do I take this home today?', 'PURCHASE_START'],
    ['Can I buy it right now?', 'PURCHASE_START'],
    ['What do I need to bring?', 'PURCHASE_START'],
    ['Can we get this done before the weekend?', 'PURCHASE_START'],
    ["I'm ready to buy", 'PURCHASE_START'],
    ["What's the damage after taxes?", 'OTD_QUOTE'],
    ['How much am I looking at out the door?', 'OTD_QUOTE'],
    ['Out the door price', 'OTD_QUOTE'],
    ['What if I put five grand down?', 'PAYMENT_ESTIMATE'],
    ['Send me whatever application I need.', 'CREDIT_APPLICATION'],
    ["What if my credit isn't great?", 'FINANCE_REQUEST'],
    ["I'll come after work.", 'SALES_APPOINTMENT'],
    ['Can I swing by tomorrow?', 'SALES_APPOINTMENT'],
    ['Actually I changed my mind.', 'CHANGE_OF_MIND'],
    ['Why should I buy this one?', 'VEHICLE_QUESTION'],
    ['Can someone call me?', 'HUMAN_HANDOFF'],
    ["I'm paying cash.", 'OTD_QUOTE'],
  ])('"%s" → %s', (m, intent) => {
    const r = u(m);
    expect(r.intents.map((i) => i.intent)).toContain(intent);
    expect(r.intents.map((i) => i.intent)).not.toContain('KNOWLEDGE_QUESTION');
  });
  it('"five grand down" is a $5,000 down payment', () => {
    expect(u('What if I put five grand down?').entities.downPayment).toBe(5000);
  });
  it('"five hundred down" is never read as $5', () => {
    expect(
      u('what if i put five hundred down').entities.downPayment,
    ).toBeUndefined();
  });
  it('"changed" is not fuzzy-matched to Charger', () => {
    expect(
      u('Actually I changed my mind.').entities.vehicle?.model,
    ).toBeUndefined();
  });
  it('"you keep dodging my question" is flagged as not answered', () => {
    const r = u('You keep dodging my question.');
    expect(r.entities.notAnswered).toBe(true);
    expect(r.sentiment).toBe('frustrated');
  });
  it('"after work" is a loose time that needs an exact one', () => {
    expect(u("I'll come after work.").entities.looseTime).toBe('after_work');
  });
  it('credit worries are flagged', () => {
    expect(u("What if my credit isn't great?").entities.creditConcern).toBe(
      true,
    );
  });
  it('a real model name still fuzzy-matches', () => {
    expect(
      u('do you have a wranglr', { hasSelectedVehicle: false }).entities.vehicle
        ?.model,
    ).toMatch(/wrangler/i);
  });
  it('"Who is your manager?" is a confident, specific question (model is not consulted)', () => {
    const r = u('Who is your manager?', { pending: 'confirm_handoff' });
    const k = r.intents.find((i) => i.intent === 'KNOWLEDGE_QUESTION');
    expect(k?.evidence).toBe('manager identity');
    expect(r.intents.map((i) => i.intent)).not.toContain('HUMAN_HANDOFF');
  });
});
