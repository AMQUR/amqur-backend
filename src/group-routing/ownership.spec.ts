import { fixtureGrant } from './group-routing.fixtures';
import type { ShownVehicle } from './group-routing.types';
import {
  ordinalIndex,
  resolveOwner,
  resolveShownReference,
  switchDecision,
} from './ownership';

const grant = fixtureGrant();
const N1 = 'DEMO00000000000N1';
const S1 = 'DEMO00000000000S1';

describe('resolveOwner (ownership follows the vehicle)', () => {
  it('returns the one listed rooftop that holds the VIN', () => {
    expect(
      resolveOwner(grant, [{ vin: N1, tenantId: 't_north' }]),
    ).toMatchObject({ kind: 'owner', member: { tenantId: 't_north' } });
  });
  it('refuses a VIN held only by a non-member tenant', () => {
    expect(
      resolveOwner(grant, [{ vin: N1, tenantId: 't_other_group' }]),
    ).toEqual({ kind: 'not_found' });
    expect(resolveOwner(grant, [])).toEqual({ kind: 'not_found' });
  });
  it('never guesses when two rooftops list the same VIN', () => {
    const r = resolveOwner(grant, [
      { vin: N1, tenantId: 't_north' },
      { vin: N1, tenantId: 't_south' },
    ]);
    expect(r.kind).toBe('conflict');
  });
  it('a verified reference must name the rooftop that holds the vehicle', () => {
    expect(
      resolveOwner(grant, [{ vin: N1, tenantId: 't_north' }], 't_north'),
    ).toMatchObject({ kind: 'owner' });
    expect(
      resolveOwner(grant, [{ vin: N1, tenantId: 't_north' }], 't_south'),
    ).toEqual({ kind: 'ref_mismatch' });
    expect(
      resolveOwner(
        grant,
        [
          { vin: N1, tenantId: 't_north' },
          { vin: N1, tenantId: 't_south' },
        ],
        't_south',
      ),
    ).toMatchObject({ kind: 'owner', member: { tenantId: 't_south' } });
  });
});

const shown: ShownVehicle[] = [
  {
    vin: N1,
    tenantId: 't_north',
    year: 2026,
    make: 'Jeep',
    model: 'Grand Cherokee',
    trim: 'Limited',
    color: 'Bright White',
  },
  {
    vin: S1,
    tenantId: 't_south',
    year: 2026,
    make: 'Jeep',
    model: 'Grand Cherokee',
    trim: 'Overland',
    color: 'Velvet Red',
  },
  {
    vin: 'DEMO00000000000S2',
    tenantId: 't_south',
    year: 2025,
    make: 'Ram',
    model: '1500',
    trim: 'Big Horn',
    color: 'Granite',
  },
];

describe('resolveShownReference (on the mixed-rooftop list)', () => {
  const ref = (m: string, want?: Parameters<typeof resolveShownReference>[3]) =>
    resolveShownReference(m, shown, grant, want);
  it('resolves ordinals in list order, EN and ES', () => {
    expect(ref('the first one')).toMatchObject({
      kind: 'one',
      vehicle: { vin: N1 },
    });
    expect(ref('el segundo')).toMatchObject({
      kind: 'one',
      vehicle: { vin: S1 },
    });
    expect(ref('Number 2: 2026 Jeep Grand Cherokee')).toMatchObject({
      kind: 'one',
      vehicle: { vin: S1 },
    });
    expect(ref('the last one')).toMatchObject({
      vehicle: { tenantId: 't_south', model: '1500' },
    });
    expect(ref('the sixth one')).toEqual({ kind: 'none' });
    expect(ordinalIndex('no ordinal here', 3)).toBeNull();
    // an ordinal on a non-vehicle noun is conversation, not a pick from the list
    for (const m of [
      'Wait, what was my first question again?',
      'what was the first real question I asked you',
      'the last time I came in was March',
      'I want a second opinion',
      '¿cuál fue mi primera pregunta?',
    ])
      expect(ordinalIndex(m, 3)).toBeNull();
    expect(ordinalIndex('tell me about the first one', 3)).toBe(0);
    expect(ordinalIndex('the last truck please', 3)).toBe(2);
  });
  it('resolves by side, colour, model or trim only when exactly one fits', () => {
    expect(ref('the north one')).toMatchObject({
      kind: 'one',
      vehicle: { vin: N1 },
    });
    expect(ref('the south one')).toMatchObject({ kind: 'ambiguous' });
    expect(ref('the velvet red one')).toMatchObject({
      kind: 'one',
      vehicle: { vin: S1 },
    });
    expect(ref('the Ram', { model: '1500' })).toMatchObject({
      kind: 'one',
      vehicle: { model: '1500' },
    });
    expect(
      ref('that Grand Cherokee', { model: 'Grand Cherokee' }),
    ).toMatchObject({ kind: 'ambiguous' });
    expect(ref('the Overland', { trim: 'Overland' })).toMatchObject({
      kind: 'one',
      vehicle: { vin: S1 },
    });
  });
  it('does not invent a reference', () => {
    expect(ref('what about payments?')).toEqual({ kind: 'none' });
    expect(resolveShownReference('the first one', [], grant)).toEqual({
      kind: 'none',
    });
  });
});

describe('switchDecision (second rooftop never inherits contact or consent)', () => {
  it('never carries contact; tells the customer once', () => {
    expect(
      switchDecision({
        fromTenantId: 't_north',
        toTenantId: 't_south',
        fromHasContact: true,
        alreadyLinkedTo: false,
      }),
    ).toEqual({ switching: true, carryContact: false, notice: true });
    expect(
      switchDecision({
        fromTenantId: 't_north',
        toTenantId: 't_south',
        fromHasContact: false,
        alreadyLinkedTo: false,
      }).notice,
    ).toBe(false);
    expect(
      switchDecision({
        fromTenantId: 't_north',
        toTenantId: 't_south',
        fromHasContact: true,
        alreadyLinkedTo: true,
      }).notice,
    ).toBe(false);
    expect(
      switchDecision({
        fromTenantId: 't_north',
        toTenantId: 't_north',
        fromHasContact: true,
        alreadyLinkedTo: true,
      }),
    ).toEqual({ switching: false, carryContact: false, notice: false });
    expect(
      switchDecision({
        fromTenantId: null,
        toTenantId: 't_north',
        fromHasContact: false,
        alreadyLinkedTo: false,
      }).switching,
    ).toBe(false);
  });
});
