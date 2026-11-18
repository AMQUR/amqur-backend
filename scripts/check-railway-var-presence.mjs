#!/usr/bin/env node
/**
 * Print SET/MISSING for named Railway variables. Never prints values.
 *
 * Usage:
 *   RAILWAY_API_TOKEN=… RAILWAY_PROJECT_ID=… \
 *     node scripts/check-railway-var-presence.mjs <environment> <service> KEY1 KEY2 …
 */

import {
  describeRailwayFailure,
  readRailwayVariables,
} from './lib/railway-cli.mjs';

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

let vars;
try {
  vars = readRailwayVariables({ projectId, service, environment });
} catch (error) {
  console.error(
    `BLOCKED ${environment}/${service}: could not read variables; values not printed.`,
  );
  console.error(`  ${describeRailwayFailure(error)}`);
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
