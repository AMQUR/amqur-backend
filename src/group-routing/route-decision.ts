import type { TurnIntent } from '../chat/understanding/turn-understanding';

export type RouteDecision =
  /** The group conversation answers: cross-rooftop search, greetings, general questions. */
  | { to: 'group' }
  /** The rooftop this conversation is bound to answers, in its own tenant. */
  | { to: 'owner' }
  /** A vehicle from the group list was named: its owning rooftop answers. */
  | { to: 'owner_of_reference' }
  /** Something that needs a rooftop, and none is known: ask — never guess. */
  | { to: 'ask_store' }
  | { to: 'ask_vehicle' };

const SEARCH: ReadonlySet<TurnIntent> = new Set<TurnIntent>([
  'INVENTORY_SEARCH',
  'SHOPPING_START',
]);
const LIST_WORK: ReadonlySet<TurnIntent> = new Set<TurnIntent>([
  'FEATURE_FILTER',
  'COMPARE',
]);
/** About ONE vehicle: needs to know which, and its rooftop answers. */
const VEHICLE: ReadonlySet<TurnIntent> = new Set<TurnIntent>([
  'SELECT_VEHICLE',
  'VEHICLE_QUESTION',
  'PAYMENT_ESTIMATE',
  'OTD_QUOTE',
  'HOLD_REQUEST',
  'PURCHASE_START',
  'RESUME_VEHICLE',
  'SALES_APPOINTMENT',
]);
/** Creates or reads a rooftop's records, or is answered from one rooftop's own facts. */
const ROOFTOP: ReadonlySet<TurnIntent> = new Set<TurnIntent>([
  ...VEHICLE,
  'FINANCE_REQUEST',
  'CREDIT_APPLICATION',
  'TRADE_IN',
  'SERVICE_APPOINTMENT',
  'APPOINTMENT_RESCHEDULE',
  'APPOINTMENT_CANCEL',
  'SERVICE_AMENITY_QUESTION',
  'SERVICE_STATUS',
  'PARTS_INQUIRY',
  'HOURS_LOCATION',
  'HUMAN_HANDOFF',
  'COMPLAINT',
  'PROVIDE_CONTACT',
  'TEXT_CONTINUATION',
]);
const SHORT_REPLY: ReadonlySet<TurnIntent> = new Set<TurnIntent>([
  'AFFIRM',
  'DECLINE',
  'UNKNOWN',
  'CHANGE_OF_MIND',
]);
const ACTION_INTENT: Record<string, TurnIntent> = {
  payment_estimate: 'PAYMENT_ESTIMATE',
  vehicle_detail: 'SELECT_VEHICLE',
  hold_vehicle: 'HOLD_REQUEST',
  finance: 'FINANCE_REQUEST',
  credit_application: 'CREDIT_APPLICATION',
  test_drive: 'SALES_APPOINTMENT',
  trade: 'TRADE_IN',
  compare: 'COMPARE',
  service: 'SERVICE_APPOINTMENT',
  parts: 'PARTS_INQUIRY',
  sales: 'INVENTORY_SEARCH',
  human: 'HUMAN_HANDOFF',
  hours: 'HOURS_LOCATION',
  select: 'SELECT_VEHICLE',
};

export function effectiveIntents(
  intents: ReadonlyArray<{ intent: TurnIntent; confidence: number }>,
  action?: string,
): TurnIntent[] {
  const list = intents.filter((i) => i.confidence >= 0.6).map((i) => i.intent);
  const forced = action ? ACTION_INTENT[action] : undefined;
  if (forced && !list.includes(forced)) list.unshift(forced);
  return list.length ? list : ['UNKNOWN'];
}

/**
 * Who answers this turn on the group site. Pure: every input is server-side state or the
 * server's own reading of the message.
 *
 * The invariant it protects: the group tenant's own conversation only ever searches and
 * chats. Anything that reads or creates a customer record is answered inside the tenant of
 * the rooftop that owns it — or, when no rooftop is known, by asking which store.
 */
export function decideRoute(input: {
  intents: TurnIntent[];
  /** A lead-form or appointment-picker submission. */
  structured: boolean;
  /** The message carries a phone number or an email address. */
  carriesContact: boolean;
  bound: boolean;
  /** The bound rooftop's assistant is waiting on an answer (a date, a name, a ZIP…). */
  ownerAwaitingAnswer: boolean;
  listSurface: 'group' | 'owner' | undefined;
  lastSurface: 'group' | 'owner' | undefined;
  hasShown: boolean;
  /** Result of resolving the message against the group list. */
  reference: 'one' | 'ambiguous' | 'none';
  /** Urgent safety report or customer-reported incident. */
  safety: boolean;
  /** The group tenant has its own explicitly configured handoff queue. */
  groupQueue: boolean;
}): RouteDecision {
  const i = new Set(input.intents);
  const any = (set: ReadonlySet<TurnIntent>) =>
    input.intents.some((x) => set.has(x));
  const owner: RouteDecision = { to: 'owner' };

  if (input.structured) return input.bound ? owner : { to: 'group' };
  // Contact details are only ever handed to a rooftop — never stored against the group.
  if (input.carriesContact) return input.bound ? owner : { to: 'ask_store' };

  if (any(SEARCH)) return { to: 'group' };

  const groupList = input.listSurface === 'group' && input.hasShown;
  if (any(LIST_WORK))
    return groupList || !input.bound ? { to: 'group' } : owner;

  // The customer is looking at the group list: "the first one" is a vehicle on it, even while
  // a rooftop is waiting on an unrelated answer.
  const lookingAtGroupList = groupList && input.lastSurface !== 'owner';
  if (
    groupList &&
    input.reference === 'one' &&
    (lookingAtGroupList || !input.ownerAwaitingAnswer)
  )
    return { to: 'owner_of_reference' };
  if (
    groupList &&
    i.has('SELECT_VEHICLE') &&
    !(input.bound && input.ownerAwaitingAnswer && !lookingAtGroupList)
  ) {
    if (input.reference === 'ambiguous') return { to: 'ask_vehicle' };
    return input.bound ? owner : { to: 'ask_vehicle' };
  }

  if (input.bound) {
    // "yes" / "no" to something the group search just asked belongs to the group search.
    if (
      input.lastSurface === 'group' &&
      input.intents.every(
        (x) =>
          SHORT_REPLY.has(x) && (x !== 'UNKNOWN' || !input.ownerAwaitingAnswer),
      )
    )
      return { to: 'group' };
    return owner;
  }

  if (input.safety) return { to: 'group' };
  if (any(ROOFTOP)) {
    if (
      input.groupQueue &&
      input.intents.every(
        (x) => x === 'HUMAN_HANDOFF' || x === 'COMPLAINT' || !ROOFTOP.has(x),
      )
    )
      return { to: 'group' };
    if (
      groupList &&
      i.has('VEHICLE_QUESTION') &&
      input.intents.every((x) => x === 'VEHICLE_QUESTION' || !ROOFTOP.has(x))
    )
      return { to: 'group' };
    if (groupList && any(VEHICLE)) return { to: 'ask_vehicle' };
    return { to: 'ask_store' };
  }
  return { to: 'group' };
}

/** Capabilities the group tenant's own conversation may use. Everything else needs a rooftop. */
export const GROUP_CONVERSATION_CAPABILITIES: ReadonlySet<string> = new Set([
  'chat',
  'inventory',
  'vehicleCompare',
  'knowledge',
]);
