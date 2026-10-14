import { envValidationSchema } from './env.validation';

const base = { DATABASE_URL: 'postgresql://x', JWT_SECRET: 'x'.repeat(40) };

describe('env validation', () => {
  it('development boots with optional integrations absent', () => {
    expect(
      envValidationSchema.validate({ ...base, NODE_ENV: 'development' }).error,
    ).toBeUndefined();
  });
  it('production fails closed without CORS origins or encryption key, and never echoes values', () => {
    const r = envValidationSchema.validate(
      { ...base, NODE_ENV: 'production' },
      { abortEarly: false },
    );
    expect(r.error?.message).toMatch(/CORS_ORIGINS/);
    expect(r.error?.message).toMatch(/INTEGRATION_ENCRYPTION_KEY/);
    expect(r.error?.message).not.toContain(base.JWT_SECRET);
  });
  it('production boots when unsafe defaults are resolved; optional providers stay optional', () => {
    const r = envValidationSchema.validate({
      ...base,
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://dealer.example',
      INTEGRATION_ENCRYPTION_KEY: 'k'.repeat(40),
    });
    expect(r.error).toBeUndefined();
    expect(r.value.ANTHROPIC_MODEL).toBe('claude-sonnet-5-5');
  });
  it('rejects short JWT secrets', () => {
    expect(
      envValidationSchema.validate({ ...base, JWT_SECRET: 'short' }).error,
    ).toBeDefined();
  });
});
