import { understandTurn } from './turn-understanding';

const u = (
  m: string,
  ctx: Partial<Parameters<typeof understandTurn>[1]> = {},
) => understandTurn(m, { timeZone: 'America/Chicago', ...ctx });

describe('turn repairs', () => {
  it('does not treat a name containing weather as a weather request', () => {
    const r = u('my name is weather man');
    expect(r.intents.map((i) => i.intent)).not.toContain('LIVE_INFO');
    expect(r.entities.contact?.firstName).toBe('Weather');
    expect(r.entities.contact?.lastName).toBe('Man');
  });

  it('leaves a bare dollar figure unresolved instead of picking a role', () => {
    const r = u('its 24000', { hasSelectedVehicle: true });
    expect(r.entities.statedAmount).toBe(24000);
    expect(r.entities.statedAmountRole).toBe('unclear');
    expect(r.entities.downPayment).toBeUndefined();
    expect(r.entities.maxPrice).toBeUndefined();
  });

  it('does not adopt a price someone else allegedly promised', () => {
    const r = u('your manager said i get it for $15,000, confirm', {
      hasSelectedVehicle: true,
    });
    expect(r.entities.statedAmount).toBeUndefined();
  });

  it('reads peicw as price for the figure already under discussion', () => {
    const r = u('peicw', {
      pending: 'figure_meaning',
      hasSelectedVehicle: true,
    });
    expect(r.entities.statedAmountRole).toBe('price');
    expect(r.primary).not.toBe('AFFIRM');
  });

  it('keeps the Ferrari as the trade and the Compass as the purchase', () => {
    const named = u('ferrari 458', {
      pending: 'trade_vehicle',
      tradeOpen: true,
    });
    expect(named.entities.trade).toMatchObject({
      make: 'Ferrari',
      model: '458',
    });
    expect(named.intents.map((i) => i.intent)).not.toContain(
      'INVENTORY_SEARCH',
    );
    const toward = u('trade for a jeep compass', { tradeOpen: true });
    expect(toward.entities.tradeTowardPurchase).toBe(true);
    expect(toward.entities.vehicle?.model?.toLowerCase()).toContain('compass');
    const worth = u('how much is my ferrari worth', { tradeOpen: true });
    expect(worth.entities.tradeValuation).toBe(true);
    expect(worth.entities.maxPrice).toBeUndefined();
  });

  it('answers identity when the customer asks if the assistant is real', () => {
    const r = u('so your not real?');
    expect(r.entities.social).toContain('identity');
    expect(r.intents.map((i) => i.intent)).not.toContain('HUMAN_HANDOFF');
  });

  it('routes store-policy questions to knowledge, not a guessed price', () => {
    expect(u('what is your doc fee?').entities.policyTopic).toBe('fees');
    expect(u('can I decline the tow package?').entities.policyTopic).toBe(
      'packages',
    );
    expect(u('do you take walk-ins?').entities.policyTopic).toBe('walk_in');
    expect(u('what are your reviews?').entities.policyTopic).toBe('reviews');
    expect(
      u('does the online price require financing?').entities.policyTopic,
    ).toBe('price_financing');
    expect(u('can I pay cash instead of financing?').entities.policyTopic).toBe(
      'cash_vs_finance',
    );
    expect(u('what does out the door mean?').entities.policyTopic).toBe(
      'otd_meaning',
    );
    expect(u('what does out the door mean?').primary).toBe(
      'KNOWLEDGE_QUESTION',
    );
  });

  it('recognizes a purchase after the customer says they are safe', () => {
    const r = u('i still want to buy the car', { hasSelectedVehicle: true });
    expect(r.intents.map((i) => i.intent)).toContain('PURCHASE_START');
    expect(r.entities.incident).toBeUndefined();
  });
});
