/**
 * Rate-limit ceilings.
 *
 * Production values are the defaults everywhere. The disposable test stack and the load lab
 * (`NODE_ENV=test`) raise them so paced browser suites are not throttled. A test that needs to
 * exercise the REAL production ceiling sets `RATE_LIMIT_PROFILE=production`; that switch can only
 * select the stricter production numbers, never raise a limit, and has no effect outside
 * `NODE_ENV=test` (where production numbers already apply).
 *
 * The value is resolved per request (the throttler accepts a resolver function), so a suite can
 * flip the profile without re-importing the application.
 */
export function rateLimitProfile(
  env: NodeJS.ProcessEnv = process.env,
): 'production' | 'test' {
  return env.NODE_ENV === 'test' && env.RATE_LIMIT_PROFILE !== 'production'
    ? 'test'
    : 'production';
}

export function rateLimit(production: number, test: number): () => number {
  return () => (rateLimitProfile() === 'test' ? test : production);
}
