import type { GroupGrant } from './group-routing.types';
import { MemberTenantInput, resolveGroupGrant } from './membership';

/** Synthetic five-rooftop group used by unit tests. No real customer or store data. */
export const GROUP = {
  id: 'grp_1',
  slug: 'dial-auto-group',
  name: 'Dial Auto Group',
  groupSiteTenantId: 't_group',
};

const loc = (id: string, name: string) => ({
  id,
  name,
  listed: true,
  inventoryReady: true,
});

export function fixtureTenants(): MemberTenantInput[] {
  return [
    {
      id: 't_chevy',
      slug: 'dial-chevy-of-chicago',
      name: 'Dial Chevy of Chicago',
      dealerGroupId: GROUP.id,
      publicConfig: { groupAliases: ['dial chevy', 'dial chevrolet'] },
      locations: [loc('l_chevy', 'Dial Chevy of Chicago')],
    },
    {
      id: 't_nissan',
      slug: 'dial-nissan-of-chicago',
      name: 'Dial Nissan of Chicago',
      dealerGroupId: GROUP.id,
      publicConfig: {},
      locations: [loc('l_nissan', 'Dial Nissan of Chicago')],
    },
    {
      id: 't_infiniti',
      slug: 'infiniti-of-chicago',
      name: 'INFINITI of Chicago',
      dealerGroupId: GROUP.id,
      publicConfig: null,
      locations: [loc('l_infiniti', 'INFINITI of Chicago')],
    },
    {
      id: 't_south',
      slug: 'dial-cdjr-of-chicago',
      name: 'Dial Chrysler Dodge Jeep Ram of Chicago',
      dealerGroupId: GROUP.id,
      publicConfig: {
        groupSide: 'south',
        groupAliases: ['Dial Jeep', 'dial cdjr'],
      },
      locations: [loc('l_south', 'Dial Chrysler Dodge Jeep Ram of Chicago')],
    },
    {
      id: 't_north',
      slug: 'jeep-of-chicago',
      name: 'Jeep of Chicago',
      dealerGroupId: GROUP.id,
      publicConfig: { groupSide: 'north' },
      locations: [loc('l_north', 'Jeep of Chicago')],
    },
  ];
}

export function fixtureGrant(
  tenants: MemberTenantInput[] = fixtureTenants(),
  flags: Record<string, boolean> = { groupSiteShopping: true },
): GroupGrant {
  const r = resolveGroupGrant({
    conversationTenantId: 't_group',
    group: GROUP,
    groupSiteTenant: { id: 't_group', dealerGroupId: GROUP.id },
    groupSiteFlags: flags,
    tenants,
  });
  if (!r.grant) throw new Error(`fixture grant refused: ${r.reason}`);
  return r.grant;
}
