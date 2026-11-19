import { fixtureGrant, fixtureTenants, GROUP } from './group-routing.fixtures';
import {
  memberOf,
  readAliases,
  readSide,
  resolveGroupGrant,
} from './membership';

const base = () => ({
  conversationTenantId: 't_group',
  group: GROUP,
  groupSiteTenant: { id: 't_group', dealerGroupId: GROUP.id },
  groupSiteFlags: { groupSiteShopping: true } as Record<string, boolean>,
  tenants: fixtureTenants(),
});

describe('resolveGroupGrant (fail-closed membership)', () => {
  it('grants the designated group site its five listed rooftops', () => {
    const r = resolveGroupGrant(base());
    expect(r.grant?.members.map((m) => m.tenantSlug).sort()).toEqual([
      'dial-cdjr-of-chicago',
      'dial-chevy-of-chicago',
      'dial-nissan-of-chicago',
      'infiniti-of-chicago',
      'jeep-of-chicago',
    ]);
    expect(memberOf(r.grant!, 't_north')?.side).toBe('north');
    expect(memberOf(r.grant!, 't_south')?.side).toBe('south');
    expect(memberOf(r.grant!, 't_chevy')?.side).toBeNull();
    expect(Object.isFrozen(r.grant)).toBe(true);
  });

  it('refuses a rooftop tenant, whatever flags it has', () => {
    for (const rooftop of ['t_north', 't_chevy']) {
      const r = resolveGroupGrant({
        ...base(),
        conversationTenantId: rooftop,
        groupSiteTenant: { id: rooftop, dealerGroupId: GROUP.id },
        groupSiteFlags: { groupSiteShopping: true, groupInventoryListed: true },
      });
      expect(r).toEqual({ grant: null, reason: 'not_a_group_site' });
    }
  });

  it('refuses when no group designates the tenant, or the row is for another tenant', () => {
    expect(resolveGroupGrant({ ...base(), group: null }).grant).toBeNull();
    expect(
      resolveGroupGrant({
        ...base(),
        group: { ...GROUP, groupSiteTenantId: null },
      }).grant,
    ).toBeNull();
    expect(
      resolveGroupGrant({ ...base(), groupSiteTenant: null }).grant,
    ).toBeNull();
  });

  it('refuses a group site that is not itself linked to the group', () => {
    const r = resolveGroupGrant({
      ...base(),
      groupSiteTenant: { id: 't_group', dealerGroupId: 'other_group' },
    });
    expect(r).toEqual({
      grant: null,
      reason: 'group_site_not_a_member_of_its_group',
    });
  });

  it('refuses when the group flag is off or absent (default off)', () => {
    const off: Array<Record<string, boolean>> = [
      {},
      { groupSiteShopping: false },
    ];
    for (const flags of off)
      expect(resolveGroupGrant({ ...base(), groupSiteFlags: flags })).toEqual({
        grant: null,
        reason: 'group_flag_off',
      });
  });

  it('includes only rooftops that opted in AND whose own inventory is ready', () => {
    const tenants = fixtureTenants();
    tenants[0].locations[0].listed = false; // chevy did not opt in
    tenants[1].locations[0].inventoryReady = false; // nissan inventory not ready
    const grant = fixtureGrant(tenants);
    expect(grant.members.map((m) => m.tenantId).sort()).toEqual([
      't_infiniti',
      't_north',
      't_south',
    ]);
  });

  it('never includes another group’s tenant, an ungrouped tenant, or the group site itself', () => {
    const tenants = [
      ...fixtureTenants(),
      {
        id: 't_other',
        slug: 'other-group-store',
        name: 'Other Store',
        dealerGroupId: 'grp_2',
        publicConfig: {},
        locations: [
          { id: 'l_o', name: 'Other', listed: true, inventoryReady: true },
        ],
      },
      {
        id: 't_solo',
        slug: 'solo',
        name: 'Solo',
        dealerGroupId: null,
        publicConfig: {},
        locations: [
          { id: 'l_s', name: 'Solo', listed: true, inventoryReady: true },
        ],
      },
      {
        id: 't_group',
        slug: 'dial-auto-group',
        name: 'Dial Auto Group',
        dealerGroupId: GROUP.id,
        publicConfig: {},
        locations: [
          { id: 'l_g', name: 'Group', listed: true, inventoryReady: true },
        ],
      },
    ];
    const ids = fixtureGrant(tenants).members.map((m) => m.tenantId);
    expect(ids).not.toContain('t_other');
    expect(ids).not.toContain('t_solo');
    expect(ids).not.toContain('t_group');
    expect(ids).toHaveLength(5);
  });

  it('refuses when no rooftop is listed', () => {
    const tenants = fixtureTenants();
    for (const t of tenants) t.locations[0].listed = false;
    expect(resolveGroupGrant({ ...base(), tenants })).toEqual({
      grant: null,
      reason: 'no_listed_rooftops',
    });
  });

  it('reads the handoff-queue flag and public side/alias attributes strictly', () => {
    expect(fixtureGrant().handoffQueue).toBe(false);
    expect(
      fixtureGrant(fixtureTenants(), {
        groupSiteShopping: true,
        groupHandoffQueue: true,
      }).handoffQueue,
    ).toBe(true);
    expect(readSide({ groupSide: 'east' })).toBeNull();
    expect(readSide('north')).toBeNull();
    expect(readAliases({ groupAliases: ['Dial Jeep', 7, 'x'] })).toEqual([
      'dial jeep',
    ]);
  });
});
