/**
 * Group-site rooftop routing — shared types. See docs/GROUP_ROOFTOP_ROUTING.md.
 *
 * A visitor on a dealer group's own website may shop across the group's rooftops, but every
 * vehicle, lead, consent record, appointment and delivery belongs to exactly one rooftop.
 */
export type RooftopSide = 'north' | 'south';

/** One rooftop that has opted in to appear on its group's site. Server-resolved only. */
export type GroupMember = {
  tenantId: string;
  tenantSlug: string;
  /** Locations of this rooftop that are listed and whose own inventory capability is ready. */
  locationIds: string[];
  primaryLocationId: string;
  /** Owner-approved public name (the rooftop's own location name). */
  name: string;
  /** Set only where two rooftops would otherwise be confused (the two Jeep stores). */
  side: RooftopSide | null;
  /** Other names customers use for this store ("dial jeep"), lowercased. */
  aliases: string[];
};

declare const grantBrand: unique symbol;

/**
 * Permission for ONE group-site conversation tenant to read its group's listed rooftops.
 * Only `resolveGroupGrant` builds one, from database rows; nothing a client sends is in it.
 */
export type GroupGrant = Readonly<{
  dealerGroupId: string;
  groupSlug: string;
  groupName: string;
  groupSiteTenantId: string;
  members: readonly GroupMember[];
  /** The group tenant has its own staffed queue for handoffs with no store chosen. */
  handoffQueue: boolean;
  readonly [grantBrand]: true;
}>;

export type ShownVehicle = {
  vin: string;
  tenantId: string;
  year?: number;
  make?: string;
  model?: string;
  trim?: string;
  color?: string;
  price?: number;
};

export type PendingGroupAsk =
  /** "North Side, South Side, or either?" before a search more than one rooftop can answer. */
  | { kind: 'search_store'; options: string[] }
  /** "Which store?" before anything that would create a record. */
  | { kind: 'request_store'; replay?: { message: string; action?: string } }
  /** The customer asked for a vehicle at a store that does not hold it. */
  | { kind: 'owner_offer'; vin: string; tenantId: string }
  | { kind: 'which_vehicle' };

/**
 * Lives in the GROUP conversation's state. Holds no customer contact detail and no id of any
 * rooftop lead, appointment or delivery — the link to a rooftop's records is a keyed hash that
 * only the server can recompute (see `ownerConversationKey`).
 */
export type GroupRoutingState = {
  v: 1;
  /** Store preference for searches: rooftops the customer chose NOT to see, or "either". */
  prefer?: { exclude: string[]; either?: boolean };
  /** Sets of rooftops already asked about — the question is asked once per set. */
  asked?: string[];
  pending?: PendingGroupAsk;
  /** The rooftop this conversation is currently talking to. */
  bound?: { tenantId: string; locationId: string; at: string };
  /** Rooftops this conversation has opened a rooftop conversation with. */
  linked?: string[];
  /** Vehicles last listed by the group search, in the order shown. */
  shown?: ShownVehicle[];
  /** Who showed the customer a list last — decides what "the first one" refers to. */
  listSurface?: 'group' | 'owner';
  /** Who answered the previous turn. */
  lastSurface?: 'group' | 'owner';
};

/** Marks a ROOFTOP conversation that was opened from the group site (server-written only). */
export type GroupOrigin = { v: 1; groupSlug: string; groupName: string };

export type Lang = 'en' | 'es';
