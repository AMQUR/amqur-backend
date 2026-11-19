import {
  groupRoutingKey,
  ownerConversationKey,
  ROOFTOP_REF_TTL_MS,
  signRooftopRef,
  verifyRooftopRef,
} from './rooftop-ref';

const key = groupRoutingKey('unit-test-secret-at-least-32-characters!!');
const members = ['t_north', 't_south', 't_chevy'];
const now = Date.UTC(2026, 9, 13, 15, 5);
const base = {
  dealerGroupId: 'grp_1',
  conversationKey: 'cv1.aaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb',
};
const check = (ref: string | null | undefined, over: object = {}) =>
  verifyRooftopRef(
    key,
    { ...base, nowMs: now, memberTenantIds: members, ...over },
    ref,
  );

describe('rooftop reference', () => {
  const north = signRooftopRef(key, {
    ...base,
    tenantId: 't_north',
    nowMs: now,
  });
  const south = signRooftopRef(key, {
    ...base,
    tenantId: 't_south',
    nowMs: now,
  });

  it('round-trips to the rooftop it was issued for', () => {
    expect(check(north)).toBe('t_north');
    expect(check(south)).toBe('t_south');
    expect(north).not.toBe(south);
  });

  it('is opaque: carries no tenant id, slug or location id', () => {
    expect(north).toMatch(/^rr1\.[0-9a-z]+\.[A-Za-z0-9_-]{22}$/);
    for (const part of north.split('.'))
      expect(Buffer.from(part, 'base64url').toString()).not.toContain('north');
    expect(north).not.toContain('t_north');
  });

  it('is stable for nearby turns, so a card keeps its reference', () => {
    expect(
      signRooftopRef(key, {
        ...base,
        tenantId: 't_north',
        nowMs: now + 60_000,
      }),
    ).toBe(north);
  });

  it('refuses a forged or altered reference', () => {
    const [v, exp, mac] = north.split('.');
    const flipped = mac.slice(0, -1) + (mac.endsWith('A') ? 'B' : 'A');
    for (const bad of [
      `${v}.${exp}.${flipped}`,
      `${v}.zzzzzz.${mac}`, // expiry pushed out without re-signing
      `rr2.${exp}.${mac}`,
      't_north',
      'rr1..',
      '',
      null,
      undefined,
      'x'.repeat(500),
    ])
      expect(check(bad)).toBeNull();
  });

  it('refuses an expired reference', () => {
    expect(
      check(north, { nowMs: now + ROOFTOP_REF_TTL_MS + 2 * 3_600_000 }),
    ).toBeNull();
    expect(check(north, { nowMs: now + ROOFTOP_REF_TTL_MS - 60_000 })).toBe(
      't_north',
    );
  });

  it('refuses a reference from another conversation, group or key', () => {
    expect(check(north, { conversationKey: 'cv1.other' })).toBeNull();
    expect(check(north, { dealerGroupId: 'grp_2' })).toBeNull();
    expect(
      verifyRooftopRef(
        groupRoutingKey('a-different-secret-at-least-32-characters'),
        { ...base, nowMs: now, memberTenantIds: members },
        north,
      ),
    ).toBeNull();
  });

  it('refuses a rooftop that is not (or no longer) a listed member', () => {
    expect(
      check(north, { memberTenantIds: ['t_south', 't_chevy'] }),
    ).toBeNull();
    const outsider = signRooftopRef(key, {
      ...base,
      tenantId: 't_other_group',
      nowMs: now,
    });
    expect(check(outsider)).toBeNull();
  });
});

describe('ownerConversationKey', () => {
  const p = {
    groupSiteTenantId: 't_group',
    groupConversationKey: base.conversationKey,
    ownerTenantId: 't_north',
  };
  it('is deterministic, per rooftop, and never a widget conversation id', () => {
    const k = ownerConversationKey(key, p);
    expect(ownerConversationKey(key, p)).toBe(k);
    expect(k).toMatch(/^grp1\.[A-Za-z0-9_-]{32}$/);
    expect(k).not.toMatch(/^cv1\./);
    expect(
      ownerConversationKey(key, { ...p, ownerTenantId: 't_south' }),
    ).not.toBe(k);
    expect(
      ownerConversationKey(key, { ...p, groupConversationKey: 'cv1.x' }),
    ).not.toBe(k);
    expect(k).not.toContain('t_north');
  });
});
