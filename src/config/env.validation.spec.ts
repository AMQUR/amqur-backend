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
  it('a dollar spend cap requires both token prices (an unpriced cap cannot be enforced)', () => {
    expect(
      envValidationSchema.validate({ ...base, LLM_DAILY_BUDGET_USD: 25 }).error
        ?.message,
    ).toMatch(/LLM_COST_INPUT_PER_MTOK/);
    expect(
      envValidationSchema.validate({
        ...base,
        LLM_TENANT_DAILY_BUDGET_USD: 5,
        LLM_COST_INPUT_PER_MTOK: 3,
      }).error?.message,
    ).toMatch(/LLM_COST_OUTPUT_PER_MTOK/);
    expect(
      envValidationSchema.validate({
        ...base,
        LLM_DAILY_BUDGET_USD: 25,
        LLM_TENANT_DAILY_BUDGET_USD: 5,
        LLM_COST_INPUT_PER_MTOK: 3,
        LLM_COST_OUTPUT_PER_MTOK: 15,
      }).error,
    ).toBeUndefined();
  });

  // ── security review M4: explicit, boot-validated deployment tier
  describe('DEPLOYMENT_TIER', () => {
    const prod = {
      ...base,
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://dealer.example',
      INTEGRATION_ENCRYPTION_KEY: 'k'.repeat(40),
    };
    const err = (env: Record<string, unknown>) =>
      envValidationSchema.validate(env).error?.message;

    it('is optional: existing deployments boot unchanged', () => {
      expect(err(prod)).toBeUndefined();
      expect(err({ ...base, NODE_ENV: 'development' })).toBeUndefined();
      expect(err({ ...base, NODE_ENV: 'test' })).toBeUndefined();
    });
    it('staging is valid with NODE_ENV=production (hosted staging) and with others', () => {
      expect(err({ ...prod, DEPLOYMENT_TIER: 'staging' })).toBeUndefined();
      expect(
        err({ ...base, NODE_ENV: 'development', DEPLOYMENT_TIER: 'staging' }),
      ).toBeUndefined();
      expect(err({ ...prod, DEPLOYMENT_TIER: 'production' })).toBeUndefined();
    });
    it('production tier requires NODE_ENV=production', () => {
      for (const NODE_ENV of ['development', 'test'])
        expect(
          err({ ...base, NODE_ENV, DEPLOYMENT_TIER: 'production' }),
        ).toMatch(/DEPLOYMENT_TIER=production requires NODE_ENV=production/);
    });
    it('a production build cannot be declared development / test', () => {
      for (const DEPLOYMENT_TIER of ['development', 'test'])
        expect(err({ ...prod, DEPLOYMENT_TIER })).toMatch(
          /not allowed with NODE_ENV=production/,
        );
    });
    it('rejects unknown tiers', () => {
      expect(err({ ...prod, DEPLOYMENT_TIER: 'prod' })).toMatch(
        /DEPLOYMENT_TIER/,
      );
    });
    it('SANDBOX_SCHEDULER_ENABLED=true: refused in the production tier, allowed on hosted staging', () => {
      expect(err({ ...prod, SANDBOX_SCHEDULER_ENABLED: 'true' })).toMatch(
        /SANDBOX_SCHEDULER_ENABLED/,
      );
      expect(
        err({
          ...prod,
          DEPLOYMENT_TIER: 'production',
          SANDBOX_SCHEDULER_ENABLED: 'true',
        }),
      ).toMatch(/SANDBOX_SCHEDULER_ENABLED/);
      expect(
        err({
          ...prod,
          DEPLOYMENT_TIER: 'staging',
          SANDBOX_SCHEDULER_ENABLED: 'true',
        }),
      ).toBeUndefined();
    });
  });
});
