import { clientIp, resolveThrottleTracker } from './throttle-tracker';

describe('resolveThrottleTracker', () => {
  it('public request: IP only — a client-supplied tenantSlug never creates a bucket', () => {
    const base = { ip: '203.0.113.9' };
    const keys = new Set(
      ['r1', 'r2', 'r3'].flatMap((slug) => [
        resolveThrottleTracker({
          ...base,
          body: { tenantSlug: slug },
        } as never),
        resolveThrottleTracker({
          ...base,
          query: { tenantSlug: slug },
        } as never),
      ]),
    );
    expect([...keys]).toEqual(['ip:203.0.113.9']);
  });

  it('widget token: tenant from the signed token + IP; rotating slugs changes nothing', () => {
    const user = { role: 'widget', sub: 'widget', tenantId: 'ten_1' };
    const a = resolveThrottleTracker({
      ip: '203.0.113.9',
      user,
      query: { tenantSlug: 'r1' },
    } as never);
    const b = resolveThrottleTracker({
      ip: '203.0.113.9',
      user,
      body: { tenantSlug: 'r2' },
    } as never);
    expect(a).toBe('w:ten_1:203.0.113.9');
    expect(b).toBe(a);
  });

  it('two tenants behind one proxy IP keep separate buckets once authenticated', () => {
    const k = (tenantId: string) =>
      resolveThrottleTracker({
        ip: '9.9.9.9',
        user: { role: 'widget', sub: 'widget', tenantId },
      });
    expect(k('ten_a')).not.toBe(k('ten_b'));
  });

  it('staff token: keyed by tenant + user id', () => {
    expect(
      resolveThrottleTracker({
        ip: '9.9.9.9',
        user: { role: 'MANAGER', sub: 'usr_7', tenantId: 'ten_1' },
      }),
    ).toBe('u:ten_1:usr_7');
  });

  it('ignores a malformed principal (no tenant) and non-string values', () => {
    expect(
      resolveThrottleTracker({
        ip: '5.6.7.8',
        user: { tenantId: { $ne: '' } },
      }),
    ).toBe('ip:5.6.7.8');
    expect(resolveThrottleTracker({ user: 'x' })).toBe('ip:unknown');
  });

  it('prefers the first proxy hop from req.ips', () => {
    expect(clientIp({ ip: '10.0.0.1', ips: ['203.0.113.7', '10.0.0.1'] })).toBe(
      '203.0.113.7',
    );
  });
});
