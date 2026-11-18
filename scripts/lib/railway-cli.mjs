/**
 * Shared Railway CLI helpers for deploy scripts.
 *
 * The CLI's stdout for `variables --json` contains raw secret values and its
 * stderr is not under our control, so neither is ever echoed. A failure is
 * reduced to a fixed, non-secret category plus an owner-actionable hint. That
 * is enough to tell "the token was rejected" apart from "the service name is
 * wrong" or "the CLI is not installed" without leaking anything.
 */

import { execFileSync } from 'node:child_process';

export const RAILWAY_FAILURE = Object.freeze({
  CLI_NOT_FOUND: 'CLI_NOT_FOUND',
  TIMEOUT: 'TIMEOUT',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  NETWORK: 'NETWORK',
  CLI_USAGE: 'CLI_USAGE',
  INVALID_OUTPUT: 'INVALID_OUTPUT',
  UNKNOWN: 'UNKNOWN',
});

const HINTS = Object.freeze({
  CLI_NOT_FOUND:
    'railway CLI is not on PATH; the "Install Railway CLI" step did not succeed.',
  TIMEOUT: 'railway CLI did not answer in time; retry the workflow.',
  UNAUTHORIZED:
    'Railway rejected RAILWAY_API_TOKEN. Owner action: create a new account- or workspace-scoped token with access to this project and store it as the RAILWAY_API_TOKEN repository secret (never paste it anywhere else).',
  FORBIDDEN:
    'RAILWAY_API_TOKEN is valid but lacks access to this project, environment or service. Owner action: use a token from an account/workspace that is a member of the project.',
  NOT_FOUND:
    'Railway did not find the project, environment or service named in the workflow; check RAILWAY_PROJECT_ID and the service/environment names.',
  RATE_LIMITED: 'Railway rate-limited the request; retry later.',
  NETWORK: 'Network or Railway API error; retry the workflow.',
  CLI_USAGE:
    'The installed railway CLI did not accept these arguments; the CLI is installed unpinned, so pin a known-good version.',
  INVALID_OUTPUT:
    'railway CLI succeeded but its output was not the expected JSON shape; the CLI output format may have changed.',
  UNKNOWN: 'Unclassified railway CLI failure.',
});

/** Ordered: first match wins. Patterns match CLI/API wording, never values. */
const STDERR_RULES = [
  [RAILWAY_FAILURE.UNAUTHORIZED, /unauthori[sz]ed|not authenticated|invalid.{0,20}token|\b401\b/i],
  [RAILWAY_FAILURE.FORBIDDEN, /forbidden|required role|not have access|permission denied|\b403\b/i],
  [RAILWAY_FAILURE.RATE_LIMITED, /rate.?limit|too many requests|\b429\b/i],
  [RAILWAY_FAILURE.NOT_FOUND, /not found|no such|does not exist|\b404\b/i],
  [RAILWAY_FAILURE.CLI_USAGE, /unexpected argument|unrecognized|invalid value|usage:/i],
  [
    RAILWAY_FAILURE.NETWORK,
    /ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|dns|network|connection|timed? ?out|\b50[0234]\b/i,
  ],
];

/**
 * Reduce any failure from running or parsing the Railway CLI to a category.
 * The returned object is safe to print: it never contains stdout or stderr.
 */
export function classifyRailwayFailure(error) {
  const exitStatus = Number.isInteger(error?.status) ? error.status : null;
  let category = RAILWAY_FAILURE.UNKNOWN;

  if (error?.code === 'ENOENT') {
    category = RAILWAY_FAILURE.CLI_NOT_FOUND;
  } else if (error?.code === 'ETIMEDOUT' || error?.killed === true) {
    category = RAILWAY_FAILURE.TIMEOUT;
  } else if (
    error instanceof SyntaxError ||
    error?.message === 'invalid format'
  ) {
    category = RAILWAY_FAILURE.INVALID_OUTPUT;
  } else {
    const stderr = String(error?.stderr ?? '');
    const match = STDERR_RULES.find(([, pattern]) => pattern.test(stderr));
    if (match) category = match[0];
  }

  return { category, exitStatus, hint: HINTS[category] };
}

/** One printable line; contains only the category, exit status and hint. */
export function describeRailwayFailure(error) {
  const { category, exitStatus, hint } = classifyRailwayFailure(error);
  const status = exitStatus === null ? '' : ` exit=${exitStatus}`;
  return `category=${category}${status} — ${hint}`;
}

/** Normalise the shapes `railway variables --json` has used into a flat map. */
export function asVariables(raw) {
  let current = raw;
  for (let i = 0; i < 3; i += 1) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) break;
    if (current.variables) current = current.variables;
    else if (current.data) current = current.data;
    else break;
  }
  if (Array.isArray(current)) {
    const entries = current.map((record) => [
      record?.name ?? record?.key,
      record?.value,
    ]);
    if (entries.some(([key]) => typeof key !== 'string')) {
      throw new Error('invalid format');
    }
    return Object.fromEntries(entries);
  }
  if (!current || typeof current !== 'object') throw new Error('invalid format');
  return current;
}

const EXEC_OPTIONS = Object.freeze({
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  maxBuffer: 8 * 1024 * 1024,
  timeout: 90_000,
});

/** Run the CLI; output is returned to the caller and never printed here. */
export function runRailway(args, exec = execFileSync) {
  return exec('railway', args, { ...EXEC_OPTIONS, env: process.env });
}

/** Read one service's variables as a flat map. Throws; classify the error. */
export function readRailwayVariables(
  { projectId, service, environment },
  exec = execFileSync,
) {
  const out = runRailway(
    [
      'variables',
      '--project',
      projectId,
      '--service',
      service,
      '--environment',
      environment,
      '--json',
    ],
    exec,
  );
  return asVariables(JSON.parse(out));
}

/** CLI version for the log (not secret); 'unavailable' if it cannot be read. */
export function railwayCliVersion(exec = execFileSync) {
  try {
    return String(runRailway(['--version'], exec)).trim().slice(0, 40);
  } catch {
    return 'unavailable';
  }
}
