/**
 * Fail-closed gate for scripts/bootstrap-dial-rooftops.ts (identity-only bootstrap of the
 * five real Dial Auto Group rooftops). Pure: reads only the env object it is given.
 *
 * Required:
 *   DIAL_BOOTSTRAP_ENABLED=true
 *   DATABASE_URL                       a valid URL
 *   BOOTSTRAP_WIDGET_ORIGINS           comma-separated https origins. No wildcard, no path,
 *                                      no empty list. http is accepted ONLY for
 *                                      localhost / 127.0.0.1, and never in the production tier.
 *   DEPLOYMENT_TIER / NODE_ENV         must be a valid combination
 * Production tier additionally:
 *   DIAL_BOOTSTRAP_CONFIRM=identity-only
 */
import {
  deploymentTierProblem,
  resolveDeploymentTier,
  type DeploymentTier,
} from '../../src/config/deployment-tier';

export const DIAL_BOOTSTRAP_CONFIRM_PHRASE = 'identity-only';

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1'];

export function parseBootstrapWidgetOrigins(
  raw: string | undefined,
  opts: { allowLoopbackHttp: boolean },
): string[] {
  const parts = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length)
    throw new Error(
      'BOOTSTRAP_WIDGET_ORIGINS is required (comma-separated https origins).',
    );
  const out: string[] = [];
  for (const p of parts) {
    if (p.includes('*'))
      throw new Error(
        `BOOTSTRAP_WIDGET_ORIGINS: wildcard origin refused ('${p}').`,
      );
    let u: URL;
    try {
      u = new URL(p);
    } catch {
      throw new Error(
        `BOOTSTRAP_WIDGET_ORIGINS: '${p}' is not a valid origin.`,
      );
    }
    if (u.username || u.password)
      throw new Error(
        'BOOTSTRAP_WIDGET_ORIGINS: an origin must not contain credentials.',
      );
    if (p.toLowerCase().replace(/\/$/, '') !== u.origin)
      throw new Error(
        `BOOTSTRAP_WIDGET_ORIGINS: '${p}' must be a bare origin (scheme://host[:port], no path or query).`,
      );
    const loopback = LOOPBACK_HOSTS.includes(u.hostname);
    if (u.protocol === 'http:') {
      if (!loopback || !opts.allowLoopbackHttp)
        throw new Error(
          `BOOTSTRAP_WIDGET_ORIGINS: http origin refused ('${u.origin}'); https is required` +
            (loopback ? ' in the production tier.' : '.'),
        );
    } else if (u.protocol !== 'https:') {
      throw new Error(
        `BOOTSTRAP_WIDGET_ORIGINS: unsupported scheme in '${p}'.`,
      );
    }
    if (!out.includes(u.origin)) out.push(u.origin);
  }
  return out;
}

export function assertDialBootstrapAllowed(
  env: NodeJS.ProcessEnv = process.env,
): { tier: DeploymentTier; dbHost: string; origins: string[] } {
  if ((env.DIAL_BOOTSTRAP_ENABLED ?? '').trim() !== 'true')
    throw new Error(
      'Refusing Dial rooftop bootstrap: set DIAL_BOOTSTRAP_ENABLED=true explicitly.',
    );

  const tierProblem = deploymentTierProblem(env);
  if (tierProblem)
    throw new Error(`Refusing Dial rooftop bootstrap: ${tierProblem}.`);
  const tier = resolveDeploymentTier(env);

  if (
    tier === 'production' &&
    (env.DIAL_BOOTSTRAP_CONFIRM ?? '').trim() !== DIAL_BOOTSTRAP_CONFIRM_PHRASE
  )
    throw new Error(
      `Refusing Dial rooftop bootstrap in the production tier: set DIAL_BOOTSTRAP_CONFIRM=${DIAL_BOOTSTRAP_CONFIRM_PHRASE}.`,
    );

  if (!(env.DATABASE_URL ?? '').trim())
    throw new Error(
      'Refusing Dial rooftop bootstrap: DATABASE_URL is not set.',
    );
  let dbHost: string;
  try {
    dbHost = new URL(env.DATABASE_URL as string).hostname;
  } catch {
    throw new Error(
      'Refusing Dial rooftop bootstrap: DATABASE_URL is not a valid URL.',
    );
  }
  if (!dbHost)
    throw new Error(
      'Refusing Dial rooftop bootstrap: DATABASE_URL has no host.',
    );

  const origins = parseBootstrapWidgetOrigins(env.BOOTSTRAP_WIDGET_ORIGINS, {
    allowLoopbackHttp: tier !== 'production',
  });

  return { tier, dbHost, origins };
}
