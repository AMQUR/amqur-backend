import { AsyncLocalStorage } from 'async_hooks';
import type { Prisma } from '@prisma/client';
import type { GroupGrant, GroupMember, Lang } from './group-routing.types';
import { needsStoreFirst } from './group-copy';
import { GROUP_CONVERSATION_CAPABILITIES } from './route-decision';

/**
 * THE cross-rooftop read path.
 *
 * Every inventory query in the codebase filters by one `tenantId`. The single exception is a
 * group-site conversation, and it is expressed in exactly one place: `groupVehicleScope`
 * below builds the widened WHERE clause from a `GroupGrant` (database-resolved membership),
 * and `runInGroupScope` is the only way to make it apply — it is called by
 * GroupInventoryService and nowhere else.
 *
 * Inside the scope, `InventoryEngine` swaps `tenantId = <group site>` for the member clause.
 * A read for any OTHER tenant id is never widened, in or out of the scope.
 */
export type GroupScope = {
  grant: GroupGrant;
  /** Listed rooftops this turn may read (the customer may have excluded some). */
  searchable: readonly GroupMember[];
  lang: Lang;
  /** Set by the search hook when it asks which store instead of searching. */
  outcome: {
    asked?: { options: string[]; signature: string };
    reads: number;
  };
  /** Decides whether to ask which store first; injected so this module stays dependency-free. */
  beforeSearch?: (
    criteria: Record<string, unknown>,
  ) => Promise<{ text: string; quickReplies: string[] } | null>;
};

const storage = new AsyncLocalStorage<GroupScope>();

export function runInGroupScope<T>(
  scope: GroupScope,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(scope, fn);
}

export function currentGroupScope(): GroupScope | undefined {
  return storage.getStore();
}

/** The scope, only when the read is for the group site's own tenant. */
export function groupScopeFor(tenantId: string): GroupScope | undefined {
  const s = storage.getStore();
  return s && s.grant.groupSiteTenantId === tenantId ? s : undefined;
}

const NOTHING: Prisma.VehicleWhereInput = { tenantId: '__no_listed_rooftop__' };

/**
 * Vehicles of the given listed rooftops: each rooftop's own tenant AND its own listed
 * locations (plus that tenant's location-less rows, exactly as its own search includes them).
 */
export function groupVehicleScope(
  members: readonly GroupMember[],
): Prisma.VehicleWhereInput {
  if (!members.length) return NOTHING;
  return {
    OR: members.map((m) => ({
      tenantId: m.tenantId,
      OR: [{ locationId: { in: [...m.locationIds] } }, { locationId: null }],
    })),
  };
}

/**
 * Capability gate for the group site's OWN conversation: it may chat, search and compare.
 * Everything that would create a customer record (lead, appointment, handoff, finance,
 * service, parts…) is refused here, whatever the group tenant's flags say — those are
 * answered inside the owning rooftop's tenant. Returns undefined outside a group read scope
 * (every rooftop conversation), so the normal capability check runs unchanged.
 */
export function groupConversationCapability(
  tenantId: string,
  capability: string,
): { allowed: boolean; reason?: string; customerMessage?: string } | undefined {
  const scope = groupScopeFor(tenantId);
  if (!scope) return undefined;
  // Each listed rooftop already passed its own inventory capability check.
  if (capability === 'inventory') return { allowed: true };
  if (GROUP_CONVERSATION_CAPABILITIES.has(capability)) return undefined;
  if (
    scope.grant.handoffQueue &&
    (capability === 'handoff' || capability === 'leadCapture')
  )
    return undefined;
  return {
    allowed: false,
    reason: 'group_site_needs_rooftop',
    customerMessage: needsStoreFirst(scope.lang),
  };
}

/** "Which store?" before a group search more than one rooftop can answer; null otherwise. */
export async function groupSearchGate(
  tenantId: string,
  criteria: Record<string, unknown>,
): Promise<{ text: string; quickReplies: string[] } | null> {
  const scope = groupScopeFor(tenantId);
  return scope?.beforeSearch ? scope.beforeSearch(criteria) : null;
}
