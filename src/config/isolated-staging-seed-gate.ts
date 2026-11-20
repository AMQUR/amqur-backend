/**
 * Fail-closed gate for the isolated Railway staging five-rooftop seed.
 *
 * This does NOT weaken the local-only seeds (seed-group-rooftops / seed-local-demo).
 * Those remain loopback-only. This gate is for a dedicated staging script only.
 *
 * Required:
 *   ISOLATED_STAGING_SEED_ENABLED=true
 *   DEPLOYMENT_TIER=staging (resolved; never production)
 *   DATABASE_URL host ∈ ISOLATED_STAGING_SEED_DB_HOST_ALLOWLIST
 *     (default: postgres.railway.internal)
 *   RAILWAY_PROJECT_ID === ISOLATED_STAGING_SEED_PROJECT_ID
 *     (default: amqur-platform-staging project id)
 */
import { isProductionTier, resolveDeploymentTier } from './deployment-tier';

export const DEFAULT_ISOLATED_STAGING_PROJECT_ID =
  'e4d54510-bbc0-45bc-9d5b-a19a5ad5132c';

export const DEFAULT_ISOLATED_STAGING_DB_HOSTS = [
  'postgres.railway.internal',
] as const;

export type IsolatedStagingSeedGateEnv = NodeJS.ProcessEnv;

export function assertIsolatedStagingSeedAllowed(
  env: IsolatedStagingSeedGateEnv = process.env,
): { dbHost: string; projectId: string; tier: string } {
  const fail = (msg: string): never => {
    throw new Error(msg);
  };

  if ((env.ISOLATED_STAGING_SEED_ENABLED ?? '').trim() !== 'true') {
    fail(
      'Refusing isolated staging seed: set ISOLATED_STAGING_SEED_ENABLED=true explicitly.',
    );
  }

  if (isProductionTier(env)) {
    fail('Refusing isolated staging seed: production deployment tier.');
  }

  const tier = resolveDeploymentTier(env);
  if (tier !== 'staging') {
    fail(
      `Refusing isolated staging seed: DEPLOYMENT_TIER must resolve to staging (got '${tier}').`,
    );
  }

  let dbHost: string;
  try {
    dbHost = new URL(env.DATABASE_URL ?? 'postgres://x@invalid/x').hostname;
  } catch {
    return fail(
      'Refusing isolated staging seed: DATABASE_URL is not a valid URL.',
    );
  }

  const allowHosts = (
    env.ISOLATED_STAGING_SEED_DB_HOST_ALLOWLIST?.trim() ||
    DEFAULT_ISOLATED_STAGING_DB_HOSTS.join(',')
  )
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

  if (!allowHosts.includes(dbHost.toLowerCase())) {
    fail(
      `Refusing isolated staging seed: DATABASE_URL host '${dbHost}' is not in the allowlist.`,
    );
  }

  // Never allow loopback through this script — local seeds own that path.
  if (['127.0.0.1', 'localhost', '::1'].includes(dbHost.toLowerCase())) {
    fail(
      'Refusing isolated staging seed against loopback; use npm run seed:group-rooftops locally.',
    );
  }

  const expectedProject =
    (
      env.ISOLATED_STAGING_SEED_PROJECT_ID ??
      DEFAULT_ISOLATED_STAGING_PROJECT_ID
    ).trim() || DEFAULT_ISOLATED_STAGING_PROJECT_ID;
  const projectId = (env.RAILWAY_PROJECT_ID ?? '').trim();
  if (!projectId) {
    fail(
      'Refusing isolated staging seed: RAILWAY_PROJECT_ID is missing (run via Railway).',
    );
  }
  if (projectId !== expectedProject) {
    fail(
      `Refusing isolated staging seed: RAILWAY_PROJECT_ID '${projectId}' is not the isolated staging project.`,
    );
  }

  return { dbHost, projectId, tier };
}
