/**
 * Deployment tier — the ONE place that answers "is this the production deployment?" for the
 * sandbox / demo facilities (sandbox ADF transports, the sandbox scheduler, demo seeds).
 *
 * Why not `NODE_ENV`: NODE_ENV says how Node/Nest should run (hosted services, staging included,
 * run with NODE_ENV=production), not which deployment this is. A bare
 * `NODE_ENV === 'production'` compare cannot tell the hosted staging service from production.
 *
 *   DEPLOYMENT_TIER   NODE_ENV         resolved tier
 *   (unset)           production       production      ← exactly today's behaviour
 *   (unset)           test             test
 *   (unset)           anything else    development
 *   staging           any              staging
 *   production        production       production
 *   production        not production   INVALID → boot fails; helper answers `production`
 *   development|test  production       INVALID → boot fails; helper answers `production`
 *   development|test  not production   as stated
 *   anything else     any              INVALID → boot fails; helper answers `production`
 *
 * Invalid combinations resolve to `production` here (the tier in which every sandbox facility is
 * refused), so a script that never ran boot validation still fails closed.
 *
 * What a tier allows:
 *   production   live lead sending when every other gate agrees; sandbox transports, the sandbox
 *                scheduler and demo seeds are refused outright.
 *   staging      live sending is IMPOSSIBLE. Sandbox ADF transport only for SANDBOX-environment
 *                routes with reserved test recipients; sandbox scheduler only with the existing
 *                per-tenant flag and SANDBOX_SCHEDULER_ENABLED=true.
 *   development  as staging, without the reserved-recipient requirement for the in-process sink.
 *   test         same as development.
 * In every non-production tier a PRODUCTION-environment route is refused outright.
 */
export const DEPLOYMENT_TIERS = [
  'production',
  'staging',
  'development',
  'test',
] as const;
export type DeploymentTier = (typeof DEPLOYMENT_TIERS)[number];

type TierEnv = { NODE_ENV?: string; DEPLOYMENT_TIER?: string };

function stated(env: TierEnv): string {
  return (env.DEPLOYMENT_TIER ?? '').trim().toLowerCase();
}

/** Why the DEPLOYMENT_TIER / NODE_ENV combination is invalid, or null when it is fine. */
export function deploymentTierProblem(
  env: TierEnv = process.env,
): string | null {
  const raw = stated(env);
  if (!raw) return null;
  if (!(DEPLOYMENT_TIERS as readonly string[]).includes(raw))
    return `DEPLOYMENT_TIER must be one of ${DEPLOYMENT_TIERS.join(' | ')}`;
  const nodeProd = env.NODE_ENV === 'production';
  if (raw === 'production' && !nodeProd)
    return 'DEPLOYMENT_TIER=production requires NODE_ENV=production';
  if (nodeProd && (raw === 'development' || raw === 'test'))
    return `DEPLOYMENT_TIER=${raw} is not allowed with NODE_ENV=production (use staging)`;
  return null;
}

export function resolveDeploymentTier(
  env: TierEnv = process.env,
): DeploymentTier {
  const raw = stated(env);
  if (!raw) {
    if (env.NODE_ENV === 'production') return 'production';
    return env.NODE_ENV === 'test' ? 'test' : 'development';
  }
  if (deploymentTierProblem(env)) return 'production'; // fail closed
  return raw as DeploymentTier;
}

export function isProductionTier(env: TierEnv = process.env): boolean {
  return resolveDeploymentTier(env) === 'production';
}

/**
 * Live (real-recipient) sending is possible only in the production tier of a production build.
 * Every other gate (master switch, mode, verified production-enabled route…) still applies.
 */
export function liveSendingPossible(env: TierEnv = process.env): boolean {
  return (
    env.NODE_ENV === 'production' &&
    !deploymentTierProblem(env) &&
    resolveDeploymentTier(env) === 'production'
  );
}

/** Sandbox / demo facilities exist only outside the production tier. */
export function sandboxFacilitiesAllowed(env: TierEnv = process.env): boolean {
  return !isProductionTier(env);
}

/**
 * A hosted non-production deployment must never hold or hand on a real recipient, not even in
 * the in-process sink: there the sandbox requires a reserved test recipient for every transport.
 */
export function sandboxRequiresReservedRecipient(
  env: TierEnv = process.env,
): boolean {
  return resolveDeploymentTier(env) === 'staging';
}
