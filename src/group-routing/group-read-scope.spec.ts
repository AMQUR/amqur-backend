import { groupVehicleScope } from './group-read-scope';
import type { GroupMember } from './group-routing.types';

const member = (over: Partial<GroupMember>): GroupMember => ({
  tenantId: 't1',
  tenantSlug: 's1',
  locationIds: ['loc-a'],
  allLocationsListed: true,
  primaryLocationId: 'loc-a',
  name: 'Store',
  side: null,
  aliases: [],
  ...over,
});

describe('group read scope (security review L3)', () => {
  it('a rooftop with every location listed includes its location-less vehicles', () => {
    expect(groupVehicleScope([member({})])).toEqual({
      OR: [
        {
          tenantId: 't1',
          OR: [{ locationId: { in: ['loc-a'] } }, { locationId: null }],
        },
      ],
    });
  });

  it('a rooftop with only some locations listed never includes location-less vehicles', () => {
    expect(
      groupVehicleScope([
        member({ locationIds: ['loc-b'], allLocationsListed: false }),
      ]),
    ).toEqual({
      OR: [{ tenantId: 't1', OR: [{ locationId: { in: ['loc-b'] } }] }],
    });
  });

  it('no listed rooftops matches nothing', () => {
    expect(groupVehicleScope([])).toEqual({
      tenantId: '__no_listed_rooftop__',
    });
  });
});
