import { rateLimit, rateLimitProfile } from './rate-limits';

describe('rate-limit profile', () => {
  it('production numbers everywhere except NODE_ENV=test', () => {
    expect(rateLimitProfile({ NODE_ENV: 'production' })).toBe('production');
    expect(rateLimitProfile({ NODE_ENV: 'staging' })).toBe('production');
    expect(rateLimitProfile({})).toBe('production');
    expect(rateLimitProfile({ NODE_ENV: 'test' })).toBe('test');
  });

  it('RATE_LIMIT_PROFILE can only select the stricter production numbers', () => {
    expect(
      rateLimitProfile({ NODE_ENV: 'test', RATE_LIMIT_PROFILE: 'production' }),
    ).toBe('production');
    // It cannot raise limits on a production host.
    expect(
      rateLimitProfile({ NODE_ENV: 'production', RATE_LIMIT_PROFILE: 'test' }),
    ).toBe('production');
  });

  it('resolves per call, so a suite can flip the profile at runtime', () => {
    const prev = {
      n: process.env.NODE_ENV,
      p: process.env.RATE_LIMIT_PROFILE,
    };
    try {
      const limit = rateLimit(40, 10_000);
      process.env.NODE_ENV = 'test';
      delete process.env.RATE_LIMIT_PROFILE;
      expect(limit()).toBe(10_000);
      process.env.RATE_LIMIT_PROFILE = 'production';
      expect(limit()).toBe(40);
    } finally {
      process.env.NODE_ENV = prev.n;
      if (prev.p === undefined) delete process.env.RATE_LIMIT_PROFILE;
      else process.env.RATE_LIMIT_PROFILE = prev.p;
    }
  });
});
