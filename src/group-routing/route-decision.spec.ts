import { decideRoute, effectiveIntents } from './route-decision';
import type { TurnIntent } from '../chat/understanding/turn-understanding';

const base = {
  intents: ['UNKNOWN'] as TurnIntent[],
  structured: false,
  carriesContact: false,
  bound: false,
  ownerAwaitingAnswer: false,
  listSurface: undefined as 'group' | 'owner' | undefined,
  lastSurface: undefined as 'group' | 'owner' | undefined,
  hasShown: false,
  reference: 'none' as const,
  safety: false,
  groupQueue: false,
};
const route = (over: Partial<typeof base> | object) =>
  decideRoute({ ...base, ...over }).to;

describe('decideRoute', () => {
  it('search always goes to the group search, bound or not', () => {
    expect(route({ intents: ['INVENTORY_SEARCH'] })).toBe('group');
    expect(
      route({
        intents: ['INVENTORY_SEARCH'],
        bound: true,
        ownerAwaitingAnswer: true,
      }),
    ).toBe('group');
    expect(route({ intents: ['SHOPPING_START'], bound: true })).toBe('group');
  });

  it('greetings and general questions with no rooftop stay in the group conversation', () => {
    for (const i of [
      'GREETING',
      'SMALL_TALK',
      'KNOWLEDGE_QUESTION',
      'UNKNOWN',
      'AFFIRM',
    ] as TurnIntent[])
      expect(route({ intents: [i] })).toBe('group');
  });

  it('anything that needs a rooftop, with none known, asks which store — never guesses', () => {
    for (const i of [
      'HUMAN_HANDOFF',
      'SERVICE_APPOINTMENT',
      'PARTS_INQUIRY',
      'TRADE_IN',
      'FINANCE_REQUEST',
      'HOURS_LOCATION',
      'SERVICE_STATUS',
      'COMPLAINT',
      'PROVIDE_CONTACT',
    ] as TurnIntent[])
      expect(route({ intents: [i] })).toBe('ask_store');
  });

  it('contact details never reach the group conversation', () => {
    expect(route({ intents: ['INVENTORY_SEARCH'], carriesContact: true })).toBe(
      'ask_store',
    );
    expect(route({ intents: ['GREETING'], carriesContact: true })).toBe(
      'ask_store',
    );
    expect(
      route({ intents: ['UNKNOWN'], carriesContact: true, bound: true }),
    ).toBe('owner');
  });

  it('a structured submission goes to the bound rooftop; unbound it is refused by the group', () => {
    expect(route({ structured: true, bound: true })).toBe('owner');
    expect(route({ structured: true })).toBe('group');
  });

  it('a vehicle named from the group list goes to its owning rooftop', () => {
    const l = { listSurface: 'group', hasShown: true } as const;
    expect(route({ ...l, intents: ['SELECT_VEHICLE'], reference: 'one' })).toBe(
      'owner_of_reference',
    );
    expect(
      route({
        ...l,
        intents: ['PAYMENT_ESTIMATE'],
        reference: 'one',
        bound: true,
      }),
    ).toBe('owner_of_reference');
    expect(
      route({
        ...l,
        intents: ['SELECT_VEHICLE'],
        reference: 'ambiguous',
        bound: true,
      }),
    ).toBe('ask_vehicle');
    expect(
      route({ ...l, intents: ['SELECT_VEHICLE'], reference: 'none' }),
    ).toBe('ask_vehicle');
    expect(route({ ...l, intents: ['SALES_APPOINTMENT'] })).toBe('ask_vehicle');
    expect(route({ ...l, intents: ['VEHICLE_QUESTION'] })).toBe('group');
  });

  it('once bound, the rooftop answers — including answers to its own questions', () => {
    for (const i of [
      'PAYMENT_ESTIMATE',
      'SALES_APPOINTMENT',
      'APPOINTMENT_RESCHEDULE',
      'HUMAN_HANDOFF',
      'UNKNOWN',
      'AFFIRM',
      'PROVIDE_CONTACT',
    ] as TurnIntent[])
      expect(route({ intents: [i], bound: true, lastSurface: 'owner' })).toBe(
        'owner',
      );
    expect(
      route({
        intents: ['UNKNOWN'],
        bound: true,
        ownerAwaitingAnswer: true,
        lastSurface: 'group',
      }),
    ).toBe('owner');
  });

  it('a bare yes/no after a group-search question goes back to the group search', () => {
    expect(
      route({ intents: ['AFFIRM'], bound: true, lastSurface: 'group' }),
    ).toBe('group');
    expect(
      route({
        intents: ['AFFIRM', 'PAYMENT_ESTIMATE'],
        bound: true,
        lastSurface: 'group',
      }),
    ).toBe('owner');
  });

  it('filter/compare follow whoever showed the list', () => {
    expect(
      route({
        intents: ['COMPARE'],
        listSurface: 'group',
        hasShown: true,
        bound: true,
      }),
    ).toBe('group');
    expect(
      route({ intents: ['FEATURE_FILTER'], listSurface: 'owner', bound: true }),
    ).toBe('owner');
  });

  it('safety is never met with “which store?”; a handoff uses a group queue only if configured', () => {
    expect(
      route({
        intents: ['SAFETY_URGENT', 'SERVICE_APPOINTMENT'],
        safety: true,
      }),
    ).toBe('group');
    expect(route({ intents: ['HUMAN_HANDOFF'], groupQueue: true })).toBe(
      'group',
    );
    expect(
      route({
        intents: ['HUMAN_HANDOFF', 'SERVICE_APPOINTMENT'],
        groupQueue: true,
      }),
    ).toBe('ask_store');
  });
});

describe('effectiveIntents', () => {
  it('drops low-confidence intents and adds the button action', () => {
    expect(
      effectiveIntents([{ intent: 'COMPARE', confidence: 0.4 }], undefined),
    ).toEqual(['UNKNOWN']);
    expect(effectiveIntents([], 'test_drive')).toEqual(['SALES_APPOINTMENT']);
    expect(
      effectiveIntents([{ intent: 'GREETING', confidence: 0.9 }], 'human'),
    ).toEqual(['HUMAN_HANDOFF', 'GREETING']);
  });
});
