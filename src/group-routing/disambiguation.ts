import type { GroupMember, GroupRoutingState } from './group-routing.types';

export function setSignature(tenantIds: readonly string[]): string {
  return [...new Set(tenantIds)].sort().join('|');
}

export type DisambiguationDecision =
  | { ask: null }
  | {
      ask: {
        /** Rooftops that hold matching stock, in display order. */
        options: string[];
        /** `side` when every option has a side (North/South), otherwise store names. */
        style: 'side' | 'name';
        signature: string;
      };
    };

/**
 * Ask which store BEFORE showing results, only when it is a real question:
 *  - the customer named a make or model (a broad "SUVs under 40k" is shown labelled instead);
 *  - more than one rooftop the customer has not excluded holds matching stock;
 *  - they have not already said "either", and this exact set was not already asked.
 * One rooftop with stock → never ask.
 */
export function decideDisambiguation(input: {
  namedVehicle: boolean;
  /** tenantId → number of matching vehicles, for the rooftops currently searchable. */
  matchesByTenant: Record<string, number>;
  members: readonly GroupMember[];
  state: Pick<GroupRoutingState, 'prefer' | 'asked'> | undefined;
}): DisambiguationDecision {
  const excluded = new Set(input.state?.prefer?.exclude ?? []);
  const holding = input.members.filter(
    (m) =>
      !excluded.has(m.tenantId) && (input.matchesByTenant[m.tenantId] ?? 0) > 0,
  );
  if (holding.length <= 1) return { ask: null };
  if (!input.namedVehicle) return { ask: null };
  if (input.state?.prefer?.either) return { ask: null };
  const signature = setSignature(holding.map((m) => m.tenantId));
  if ((input.state?.asked ?? []).includes(signature)) return { ask: null };
  const sides = holding.map((m) => m.side);
  const style =
    sides.every((s) => !!s) && new Set(sides).size === holding.length
      ? 'side'
      : 'name';
  const ordered =
    style === 'side'
      ? [...holding].sort(
          (a, b) =>
            (a.side === 'north' ? -1 : 1) - (b.side === 'north' ? -1 : 1),
        )
      : holding;
  return { ask: { options: ordered.map((m) => m.tenantId), style, signature } };
}

/** Rooftops a group search may read right now: listed members minus the customer's exclusions. */
export function searchableMembers(
  members: readonly GroupMember[],
  state: Pick<GroupRoutingState, 'prefer'> | undefined,
): GroupMember[] {
  const excluded = new Set(
    state?.prefer?.either ? [] : (state?.prefer?.exclude ?? []),
  );
  return members.filter((m) => !excluded.has(m.tenantId));
}
