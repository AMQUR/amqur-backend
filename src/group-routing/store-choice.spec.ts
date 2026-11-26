import { fixtureGrant } from './group-routing.fixtures';
import {
  parseStoreChoice,
  preferenceFor,
  sideIn,
  storesMentioned,
} from './store-choice';

const members = fixtureGrant().members;
const parse = (m: string, expectingStore = false) =>
  parseStoreChoice(m, members, { expectingStore });

describe('parseStoreChoice', () => {
  it('reads a side in English and Spanish', () => {
    for (const m of [
      'North Side',
      'the north one please',
      'norte',
      'Lado Norte',
    ])
      expect(parse(m)).toEqual({
        kind: 'store',
        tenantId: 't_north',
        by: 'side',
      });
    for (const m of ['South Side', 'south', 'el del sur', 'Lado Sur'])
      expect(parse(m)).toEqual({
        kind: 'store',
        tenantId: 't_south',
        by: 'side',
      });
    expect(sideIn('surprise me')).toBeNull();
  });

  it('reads either / both in English and Spanish', () => {
    for (const m of [
      'Either',
      'both',
      'any store',
      'north or south, both',
      'Cualquiera',
      'ambas',
      'da igual',
    ])
      expect(parse(m)).toEqual({ kind: 'either' });
  });

  it('reads a full public name, including the quick-reply label', () => {
    expect(parse('Jeep of Chicago (North Side)')).toMatchObject({
      tenantId: 't_north',
    });
    expect(
      parse('Dial Chrysler Dodge Jeep Ram of Chicago (South Side)'),
    ).toMatchObject({ tenantId: 't_south' });
    expect(parse('INFINITI of Chicago')).toMatchObject({
      tenantId: 't_infiniti',
      by: 'name',
    });
  });

  it('“Dial Jeep” is the South store (configured alias), “Jeep of Chicago” the North', () => {
    expect(parse('book me at Dial Jeep')).toMatchObject({
      tenantId: 't_south',
    });
    expect(parse('I want Jeep of Chicago')).toMatchObject({
      tenantId: 't_north',
    });
  });

  it('never guesses between the two Jeep stores from a brand word', () => {
    for (const m of ['the Jeep store', 'the Ram dealership', 'la tienda Jeep'])
      expect(parse(m)).toEqual({
        kind: 'ambiguous',
        tenantIds: expect.arrayContaining(['t_north', 't_south']),
      });
    expect(parse('Jeep', true)).toMatchObject({ kind: 'ambiguous' });
  });

  it('a brand word alone is a store only when a store was asked for', () => {
    expect(parse('show me a Nissan Rogue')).toBeNull();
    expect(parse('Nissan', true)).toMatchObject({ tenantId: 't_nissan' });
    expect(parse('the Nissan store')).toMatchObject({ tenantId: 't_nissan' });
    expect(parse('chevy', true)).toMatchObject({ tenantId: 't_chevy' });
  });

  it('returns null for ordinary messages', () => {
    for (const m of [
      '',
      'show me Grand Cherokees',
      'what is the payment?',
      'yes',
    ])
      expect(parse(m)).toBeNull();
  });
});

describe('preferenceFor', () => {
  it('a side hides only the other sided store', () => {
    const c = parse('north')!;
    expect(preferenceFor(c, members, null)).toEqual({ exclude: ['t_south'] });
  });
  it('choosing one of the offered stores hides the other offered ones', () => {
    const c = parse('Nissan', true)!;
    expect(preferenceFor(c, members, ['t_nissan', 't_chevy'])).toEqual({
      exclude: ['t_chevy'],
    });
  });
  it('naming an un-sided store unprompted hides nothing', () => {
    expect(preferenceFor(parse('the Nissan store')!, members, null)).toEqual({
      exclude: [],
    });
  });
  it('either clears exclusions and is remembered', () => {
    expect(preferenceFor({ kind: 'either' }, members, null)).toEqual({
      exclude: [],
      either: true,
    });
  });
  it('an ambiguous choice sets no preference', () => {
    expect(preferenceFor(parse('the Jeep store')!, members, null)).toBeNull();
  });
});

describe('storesMentioned', () => {
  it('finds both stores in a cross-store request, EN and ES', () => {
    expect(
      storesMentioned(
        'I saw it at the North store, book me at the South store',
        members,
      ).sort(),
    ).toEqual(['t_north', 't_south']);
    expect(storesMentioned('agéndeme en la sur', members)).toEqual(['t_south']);
    expect(storesMentioned('book me at Dial Jeep', members)).toEqual([
      't_south',
    ]);
    expect(storesMentioned('book a test drive', members)).toEqual([]);
  });
});
