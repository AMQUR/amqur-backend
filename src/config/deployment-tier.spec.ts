import {
  deploymentTierProblem,
  isProductionTier,
  liveSendingPossible,
  resolveDeploymentTier,
  sandboxFacilitiesAllowed,
  sandboxRequiresReservedRecipient,
} from './deployment-tier';

/**
 * Truth table for the deployment tier (security review M4). Columns:
 * NODE_ENV, DEPLOYMENT_TIER → tier, boot-valid, live possible, sandbox allowed, reserved-only.
 */
type Row = [
  string | undefined,
  string | undefined,
  'production' | 'staging' | 'development' | 'test',
  boolean,
  boolean,
  boolean,
  boolean,
];
const TABLE: Row[] = [
  // tier unset: derived from NODE_ENV exactly as before
  ['production', undefined, 'production', true, true, false, false],
  ['development', undefined, 'development', true, false, true, false],
  ['test', undefined, 'test', true, false, true, false],
  [undefined, undefined, 'development', true, false, true, false],
  ['staging', undefined, 'development', true, false, true, false],
  ['production', '', 'production', true, true, false, false],
  ['production', '   ', 'production', true, true, false, false],
  // explicit production
  ['production', 'production', 'production', true, true, false, false],
  ['production', 'PRODUCTION', 'production', true, true, false, false],
  ['development', 'production', 'production', false, false, false, false],
  ['test', 'production', 'production', false, false, false, false],
  [undefined, 'production', 'production', false, false, false, false],
  // hosted staging: NODE_ENV=production is valid
  ['production', 'staging', 'staging', true, false, true, true],
  ['development', 'staging', 'staging', true, false, true, true],
  ['test', 'staging', 'staging', true, false, true, true],
  // a production build cannot be declared development / test
  ['production', 'development', 'production', false, false, false, false],
  ['production', 'test', 'production', false, false, false, false],
  ['development', 'development', 'development', true, false, true, false],
  ['development', 'test', 'test', true, false, true, false],
  ['test', 'development', 'development', true, false, true, false],
  // unknown values fail closed
  ['production', 'prod', 'production', false, false, false, false],
  ['development', 'qa', 'production', false, false, false, false],
];

describe('deployment tier truth table', () => {
  it.each(TABLE)(
    'NODE_ENV=%s DEPLOYMENT_TIER=%s → %s (valid=%s live=%s sandbox=%s reservedOnly=%s)',
    (NODE_ENV, DEPLOYMENT_TIER, tier, valid, live, sandbox, reservedOnly) => {
      const env = { NODE_ENV, DEPLOYMENT_TIER };
      expect(resolveDeploymentTier(env)).toBe(tier);
      expect(deploymentTierProblem(env) === null).toBe(valid);
      expect(liveSendingPossible(env)).toBe(live);
      expect(sandboxFacilitiesAllowed(env)).toBe(sandbox);
      expect(isProductionTier(env)).toBe(!sandbox);
      expect(sandboxRequiresReservedRecipient(env)).toBe(reservedOnly);
    },
  );

  it('live sending and sandbox facilities are never both available', () => {
    for (const [NODE_ENV, DEPLOYMENT_TIER] of TABLE) {
      const env = { NODE_ENV, DEPLOYMENT_TIER };
      expect(liveSendingPossible(env) && sandboxFacilitiesAllowed(env)).toBe(
        false,
      );
    }
  });

  it('reads process.env by default', () => {
    const prev = {
      n: process.env.NODE_ENV,
      t: process.env.DEPLOYMENT_TIER,
    };
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.DEPLOYMENT_TIER;
      expect(resolveDeploymentTier()).toBe('production');
      process.env.DEPLOYMENT_TIER = 'staging';
      expect(resolveDeploymentTier()).toBe('staging');
    } finally {
      process.env.NODE_ENV = prev.n;
      if (prev.t === undefined) delete process.env.DEPLOYMENT_TIER;
      else process.env.DEPLOYMENT_TIER = prev.t;
    }
  });
});
