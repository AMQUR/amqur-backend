import type {
  GroupGrant,
  GroupMember,
  RooftopSide,
} from './group-routing.types';

export const GROUP_SITE_FLAG = 'groupSiteShopping';
export const MEMBER_LISTED_FLAG = 'groupInventoryListed';
export const GROUP_HANDOFF_QUEUE_FLAG = 'groupHandoffQueue';

export type GroupRowInput = {
  id: string;
  slug: string;
  name: string;
  groupSiteTenantId: string | null;
};

export type MemberTenantInput = {
  id: string;
  slug: string;
  name: string;
  dealerGroupId: string | null;
  publicConfig: unknown;
  locations: Array<{
    id: string;
    name: string;
    /** This location's own effective `groupInventoryListed` flag. */
    listed: boolean;
    /** This location's own `inventory` capability result — the gate its own search uses. */
    inventoryReady: boolean;
  }>;
};

export type GrantRefusal =
  | 'not_a_group_site'
  | 'group_site_not_a_member_of_its_group'
  | 'group_flag_off'
  | 'no_listed_rooftops';

function publicField(cfg: unknown, key: string): unknown {
  return cfg && typeof cfg === 'object' && !Array.isArray(cfg)
    ? (cfg as Record<string, unknown>)[key]
    : undefined;
}

export function readSide(publicConfig: unknown): RooftopSide | null {
  const v = publicField(publicConfig, 'groupSide');
  return v === 'north' || v === 'south' ? v : null;
}

export function readAliases(publicConfig: unknown): string[] {
  const v = publicField(publicConfig, 'groupAliases');
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim().toLowerCase())
    .filter((x) => x.length >= 3 && x.length <= 60)
    .slice(0, 12);
}

/**
 * Decides — from database rows only — whether a conversation's tenant may shop across a
 * group, and which rooftops it may read. Fail-closed: every condition must hold.
 *
 *  1. a DealerGroup designates this tenant as its group site (`groupSiteTenantId`);
 *  2. that tenant is itself linked to the same group;
 *  3. the `groupSiteShopping` flag is on for it;
 *  4. a rooftop is included only if it belongs to the same group, is not the group site,
 *     has itself opted in (`groupInventoryListed`) and its own inventory capability is ready.
 */
export function resolveGroupGrant(input: {
  conversationTenantId: string;
  group: GroupRowInput | null;
  groupSiteTenant: { id: string; dealerGroupId: string | null } | null;
  groupSiteFlags: Record<string, boolean>;
  tenants: MemberTenantInput[];
}): { grant: GroupGrant } | { grant: null; reason: GrantRefusal } {
  const { group, groupSiteTenant } = input;
  if (
    !group ||
    !group.groupSiteTenantId ||
    group.groupSiteTenantId !== input.conversationTenantId ||
    !groupSiteTenant ||
    groupSiteTenant.id !== input.conversationTenantId
  )
    return { grant: null, reason: 'not_a_group_site' };
  if (groupSiteTenant.dealerGroupId !== group.id)
    return { grant: null, reason: 'group_site_not_a_member_of_its_group' };
  if (input.groupSiteFlags[GROUP_SITE_FLAG] !== true)
    return { grant: null, reason: 'group_flag_off' };

  const members: GroupMember[] = [];
  for (const t of input.tenants) {
    if (t.dealerGroupId !== group.id) continue;
    if (t.id === group.groupSiteTenantId) continue;
    const listed = t.locations.filter((l) => l.listed && l.inventoryReady);
    if (!listed.length) continue;
    members.push({
      tenantId: t.id,
      tenantSlug: t.slug,
      locationIds: listed.map((l) => l.id),
      primaryLocationId: listed[0].id,
      name: (listed[0].name || t.name).trim(),
      side: readSide(t.publicConfig),
      aliases: readAliases(t.publicConfig),
    });
  }
  if (!members.length) return { grant: null, reason: 'no_listed_rooftops' };
  members.sort((a, b) => a.name.localeCompare(b.name));
  const grant = Object.freeze({
    dealerGroupId: group.id,
    groupSlug: group.slug,
    groupName: group.name,
    groupSiteTenantId: group.groupSiteTenantId,
    members: Object.freeze(members.map((m) => Object.freeze(m))),
    handoffQueue: input.groupSiteFlags[GROUP_HANDOFF_QUEUE_FLAG] === true,
  }) as unknown as GroupGrant;
  return { grant };
}

export function memberOf(
  grant: GroupGrant,
  tenantId: string | null | undefined,
): GroupMember | null {
  if (!tenantId) return null;
  return grant.members.find((m) => m.tenantId === tenantId) ?? null;
}
