#!/usr/bin/env node
/**
 * Print SET/MISSING for named Railway variables. Never prints values.
 *
 * Usage:
 *   RAILWAY_API_TOKEN=… RAILWAY_PROJECT_ID=… \
 *     node scripts/check-railway-var-presence.mjs <environment> <service> KEY1 KEY2 …
 */

import { execFileSync } from 'node:child_process';

const [environment, service, ...keys] = process.argv.slice(2);
if (!environment || !service || keys.length === 0) {
  console.error(
    'Usage: check-railway-var-presence.mjs <env> <service> KEY1 [KEY2…]',
  );
  process.exit(2);
}

const projectId = process.env.RAILWAY_PROJECT_ID;
if (!projectId || !process.env.RAILWAY_API_TOKEN) {
  console.error('RAILWAY_PROJECT_ID and RAILWAY_API_TOKEN required');
  process.exit(2);
}

function asVariables(raw) {
  let current = raw;
  for (let i = 0; i < 3; i += 1) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) break;
    if (current.variables) current = current.variables;
    else if (current.data) current = current.data;
    else break;
  }
  if (Array.isArray(current)) {
    return Object.fromEntries(
      current.map((r) => [r?.name ?? r?.key, r?.value]),
    );
  }
  if (!current || typeof current !== 'object') throw new Error('invalid format');
  return current;
}

let vars;
try {
  const out = execFileSync(
    'railway',
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
    { encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  vars = asVariables(JSON.parse(out));
} catch {
  console.error(
    `BLOCKED ${environment}/${service}: could not read variables; values not printed.`,
  );
  process.exit(1);
}

let missing = 0;
for (const key of keys) {
  const v = vars[key];
  const set = typeof v === 'string' && v.trim().length > 0;
  console.log(`${set ? 'SET' : 'MISSING'} ${environment}/${service}: ${key}`);
  if (!set) missing += 1;
}
process.exitCode = missing > 0 ? 1 : 0;
