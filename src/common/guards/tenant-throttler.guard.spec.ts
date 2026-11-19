import { TenantThrottlerGuard } from './tenant-throttler.guard';

/**
 * Security review H1: this spec used to assert `${tenantSlug}:${ip}` buckets with the slug read
 * from the request body/query. That encoded the defect (a rotated slug minted a fresh bucket per
 * request), so the expectations were changed: a client-supplied slug never selects the bucket.
 */
describe('TenantThrottlerGuard tracker', () => {
  // getTracker is protected; exercise via a test subclass.
  class TestGuard extends TenantThrottlerGuard {
    public tracker(req: Record<string, unknown>): Promise<string> {
      return this.getTracker(req);
    }
  }
  const guard = Object.create(TestGuard.prototype) as TestGuard;

  it('public widget traffic is bucketed per IP whatever tenantSlug it sends (body)', async () => {
    await expect(
      guard.tracker({ ip: '1.2.3.4', body: { tenantSlug: 'jeep-of-chicago' } }),
    ).resolves.toBe('ip:1.2.3.4');
  });

  it('rotating the slug (body or query) does not change the bucket', async () => {
    const a = await guard.tracker({
      ip: '9.9.9.9',
      body: { tenantSlug: 'jeep-of-chicago' },
    });
    const b = await guard.tracker({
      ip: '9.9.9.9',
      query: { tenantSlug: 'dial-nissan-of-chicago' },
    });
    expect(a).toBe(b);
  });

  it('authenticated tenants behind the same proxy IP get separate buckets', async () => {
    const k = (tenantId: string) =>
      guard.tracker({
        ip: '9.9.9.9',
        user: { role: 'widget', sub: 'widget', tenantId },
        query: { tenantSlug: 'anything' },
      });
    expect(await k('ten_a')).toBe('w:ten_a:9.9.9.9');
    expect(await k('ten_a')).not.toBe(await k('ten_b'));
  });

  it('falls back to per-IP when no tenant slug present', async () => {
    await expect(guard.tracker({ ip: '5.6.7.8' })).resolves.toBe('ip:5.6.7.8');
  });

  it('ignores non-string tenant slugs (no bucket forgery via objects)', async () => {
    await expect(
      guard.tracker({ ip: '5.6.7.8', body: { tenantSlug: { $ne: '' } } }),
    ).resolves.toBe('ip:5.6.7.8');
  });

  it('prefers the first proxy hop from req.ips', async () => {
    await expect(
      guard.tracker({
        ip: '10.0.0.1',
        ips: ['203.0.113.7', '10.0.0.1'],
        body: { tenantSlug: 'jeep-of-chicago' },
      }),
    ).resolves.toBe('ip:203.0.113.7');
  });
});
