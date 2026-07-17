import { TenantThrottlerGuard } from './tenant-throttler.guard';

describe('TenantThrottlerGuard tracker isolation', () => {
  // getTracker is protected; exercise via a test subclass.
  class TestGuard extends TenantThrottlerGuard {
    public tracker(req: Record<string, unknown>): Promise<string> {
      return this.getTracker(req);
    }
  }
  const guard = Object.create(TestGuard.prototype) as TestGuard;

  it('scopes the bucket to tenant + ip for widget traffic', async () => {
    await expect(
      guard.tracker({ ip: '1.2.3.4', body: { tenantSlug: 'jeep-of-chicago' } }),
    ).resolves.toBe('jeep-of-chicago:1.2.3.4');
  });

  it('two tenants behind the same proxy IP get separate buckets', async () => {
    const a = await guard.tracker({
      ip: '9.9.9.9',
      body: { tenantSlug: 'jeep-of-chicago' },
    });
    const b = await guard.tracker({
      ip: '9.9.9.9',
      body: { tenantSlug: 'dial-nissan-of-chicago' },
    });
    expect(a).not.toBe(b);
  });

  it('reads tenant slug from query for GET widget-config', async () => {
    await expect(
      guard.tracker({
        ip: '1.2.3.4',
        query: { tenantSlug: 'infiniti-of-chicago' },
      }),
    ).resolves.toBe('infiniti-of-chicago:1.2.3.4');
  });

  it('falls back to per-IP when no tenant slug present', async () => {
    await expect(guard.tracker({ ip: '5.6.7.8' })).resolves.toBe('5.6.7.8');
  });

  it('ignores non-string tenant slugs (no bucket forgery via objects)', async () => {
    await expect(
      guard.tracker({ ip: '5.6.7.8', body: { tenantSlug: { $ne: '' } } }),
    ).resolves.toBe('5.6.7.8');
  });

  it('prefers the first proxy hop from req.ips', async () => {
    await expect(
      guard.tracker({
        ip: '10.0.0.1',
        ips: ['203.0.113.7', '10.0.0.1'],
        body: { tenantSlug: 'jeep-of-chicago' },
      }),
    ).resolves.toBe('jeep-of-chicago:203.0.113.7');
  });
});
