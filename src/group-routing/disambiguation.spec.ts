import {
  decideDisambiguation,
  searchableMembers,
  setSignature,
} from './disambiguation';
import { fixtureGrant } from './group-routing.fixtures';

const members = fixtureGrant().members;
const both = { t_north: 2, t_south: 2 };

describe('decideDisambiguation', () => {
  it('asks North/South when both Jeep stores hold the named model', () => {
    const d = decideDisambiguation({
      namedVehicle: true,
      matchesByTenant: both,
      members,
      state: undefined,
    });
    expect(d.ask).toEqual({
      options: ['t_north', 't_south'],
      style: 'side',
      signature: setSignature(['t_north', 't_south']),
    });
  });

  it('does not ask when only one rooftop has matching stock', () => {
    const cases: Array<Record<string, number>> = [
      { t_north: 3 },
      { t_north: 1, t_south: 0 },
      { t_chevy: 4 },
      {},
    ];
    for (const m of cases)
      expect(
        decideDisambiguation({
          namedVehicle: true,
          matchesByTenant: m,
          members,
          state: undefined,
        }).ask,
      ).toBeNull();
  });

  it('asks once: not again for the same set', () => {
    const state = { asked: [setSignature(['t_south', 't_north'])] };
    expect(
      decideDisambiguation({
        namedVehicle: true,
        matchesByTenant: both,
        members,
        state,
      }).ask,
    ).toBeNull();
  });

  it('a stated side or “either” settles it', () => {
    expect(
      decideDisambiguation({
        namedVehicle: true,
        matchesByTenant: both,
        members,
        state: { prefer: { exclude: ['t_south'] } },
      }).ask,
    ).toBeNull();
    expect(
      decideDisambiguation({
        namedVehicle: true,
        matchesByTenant: both,
        members,
        state: { prefer: { exclude: [], either: true } },
      }).ask,
    ).toBeNull();
  });

  it('a broad search (no make or model) is shown labelled, not interrogated', () => {
    expect(
      decideDisambiguation({
        namedVehicle: false,
        matchesByTenant: { t_north: 1, t_south: 1, t_chevy: 1, t_nissan: 1 },
        members,
        state: undefined,
      }).ask,
    ).toBeNull();
  });

  it('uses store names when the rooftops have no sides', () => {
    const d = decideDisambiguation({
      namedVehicle: true,
      matchesByTenant: { t_chevy: 1, t_nissan: 1 },
      members,
      state: undefined,
    });
    expect(d.ask?.style).toBe('name');
    expect(d.ask?.options.sort()).toEqual(['t_chevy', 't_nissan']);
  });
});

describe('searchableMembers', () => {
  it('drops excluded rooftops; “either” restores all', () => {
    expect(
      searchableMembers(members, { prefer: { exclude: ['t_south'] } }).map(
        (m) => m.tenantId,
      ),
    ).not.toContain('t_south');
    expect(
      searchableMembers(members, {
        prefer: { exclude: ['t_south'], either: true },
      }),
    ).toHaveLength(5);
    expect(searchableMembers(members, undefined)).toHaveLength(5);
  });
});
