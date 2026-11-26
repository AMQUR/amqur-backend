import {
  DEALER_DIRECTORY_HOSTS,
  DEALER_FOCUSES,
  buildDealershipCard,
  dealerDirectoryFor,
  storesNamedIn,
} from './dealer-directory';

describe('dealer directory', () => {
  const group = dealerDirectoryFor('dial-auto-group')!;

  it('lists five stores for the group site and one store for a rooftop', () => {
    expect(group.self).toBeNull();
    expect(group.group.map((s) => s.tenantSlug)).toEqual([
      'dial-chevy-of-chicago',
      'dial-nissan-of-chicago',
      'infiniti-of-chicago',
      'dial-cdjr-of-chicago',
      'jeep-of-chicago',
    ]);
    expect(dealerDirectoryFor('jeep-of-chicago')!.self!.name).toBe(
      'Jeep of Chicago',
    );
    expect(dealerDirectoryFor('some-other-dealer')).toBeNull();
  });

  it('keeps the two Jeep stores apart', () => {
    const north = group.group.find((s) => s.sourceRecordId === 'cdjr-north')!;
    const south = group.group.find((s) => s.sourceRecordId === 'cdjr-south')!;
    expect(north.address).toContain('5950 N Western');
    expect(south.address).toContain('7340 S Western');
    expect(new URL(north.links.newInventory!).hostname).toBe(
      'www.jeepofchicago.com',
    );
    expect(new URL(south.links.newInventory!).hostname).toBe(
      'www.dialjeep.com',
    );
    expect(north.phones.sales).not.toBe(south.phones.sales);
  });

  it('every link is https, on a known host, with no credentials or tokens', () => {
    for (const s of group.group)
      for (const url of Object.values(s.links)) {
        const u = new URL(url);
        expect(u.protocol).toBe('https:');
        expect(DEALER_DIRECTORY_HOSTS.has(u.hostname)).toBe(true);
        expect(u.username + u.password).toBe('');
        expect(u.search).toBe('');
        expect(url).not.toMatch(/token|tekioncloud/i);
      }
    expect([...DEALER_DIRECTORY_HOSTS].sort()).toEqual([
      'www.dialchevy.com',
      'www.dialdifference.com',
      'www.dialjeep.com',
      'www.dialnissan.com',
      'www.infinitichicago.com',
      'www.jeepofchicago.com',
    ]);
  });

  it('builds a card for every store and focus with provenance and a truthful note', () => {
    for (const s of group.group)
      for (const focus of DEALER_FOCUSES) {
        const card = buildDealershipCard(s, focus, 'en');
        expect(card.kind).toBe('dealership');
        expect(card.verified).toBe(true);
        expect(card.sourceRecordId).toBe(s.sourceRecordId);
        expect(card.asOf).toBe('2026-11-12');
        expect(card.links.length).toBeGreaterThanOrEqual(3);
        expect(card.links.filter((l) => l.primary)).toHaveLength(1);
        for (const l of card.links) {
          expect(l.url).toMatch(/^(https:\/\/|tel:\+1\d{10}$)/);
          expect(l.label.length).toBeGreaterThan(3);
        }
        expect(card.note).not.toMatch(/in stock|available now|guarantee/i);
      }
  });

  it('puts the inventory search first for shoppers and scheduling first for service', () => {
    const chevy = group.group[0];
    expect(buildDealershipCard(chevy, 'new', 'en').links[0]).toMatchObject({
      key: 'newInventory',
      url: 'https://www.dialchevy.com/searchnew.aspx',
      primary: true,
    });
    expect(buildDealershipCard(chevy, 'service', 'es').links[0]).toMatchObject({
      key: 'scheduleService',
      label: 'Programar servicio',
    });
    // Chevy has no certified page on file: the card falls back to used, never invents one.
    expect(
      buildDealershipCard(chevy, 'certified', 'en').links.map((l) => l.key),
    ).not.toContain('certifiedInventory');
  });

  it('finds the stores a message names, keeping the Jeep stores apart', () => {
    const ids = (m: string) =>
      storesNamedIn(m, group.group).map((d) => d.sourceRecordId);
    expect(ids('Can I talk to a person at the Nissan store?')).toEqual([
      'nissan',
    ]);
    expect(ids('someone from Dial Chevy please')).toEqual(['chevy']);
    expect(ids('call me from INFINITI')).toEqual(['infiniti']);
    expect(ids('I want the Jeep of Chicago team')).toEqual(['cdjr-north']);
    expect(ids('the south side Jeep store')).toEqual(['cdjr-south']);
    expect(ids('a person at the North Side CDJR')).toEqual(['cdjr-north']);
    // a shared brand names both stores, never one of them
    expect(ids('I need a Jeep salesperson')).toEqual([
      'cdjr-south',
      'cdjr-north',
    ]);
    expect(ids('who do I call about a Ram?')).toEqual([
      'cdjr-south',
      'cdjr-north',
    ]);
    expect(ids('I want to speak with a salesperson')).toEqual([]);
  });
});
