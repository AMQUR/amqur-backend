#!/usr/bin/env node

/**
 * Copy boot-required variables from Railway api → worker for one environment.
 * Never prints secret values. Used by Deploy workflow before env-preflight.
 *
 * Usage:
 *   RAILWAY_API_TOKEN=… RAILWAY_PROJECT_ID=… \
 *     node scripts/sync-worker-required-from-api.mjs <staging|production>
 *
 * For production, source service is prod-api and target is prod-worker.
 */

import { execFileSync } from 'node:child_process';

const environment = process.argv[2];
if (!['staging', 'production'].includes(environment)) {
  console.error('Usage: sync-worker-required-from-api.js <staging|production>');
  process.exit(2);
}

const projectId = process.env.RAILWAY_PROJECT_ID;
if (!projectId) {
  console.error('RAILWAY_PROJECT_ID is required');
  process.exit(2);
}
if (!process.env.RAILWAY_API_TOKEN) {
  console.error('RAILWAY_API_TOKEN is required');
  process.exit(2);
}

const sourceService = environment === 'staging' ? 'api' : 'prod-api';
const targetService = environment === 'staging' ? 'worker' : 'prod-worker';
const KEYS = ['CORS_ORIGINS', 'INTEGRATION_ENCRYPTION_KEY'];

function railwayJson(args) {
  const out = execFileSync('railway', args, {
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(out);
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

function present(vars, name, minLength) {
  return typeof vars[name] === 'string' && vars[name].trim().length >= minLength;
}

const minLen = {
  CORS_ORIGINS: 8,
  INTEGRATION_ENCRYPTION_KEY: 32,
};

let sourceVars;
let targetVars;
try {
  sourceVars = asVariables(
    railwayJson([
      'variables',
      '--project',
      projectId,
      '--service',
      sourceService,
      '--environment',
      environment,
      '--json',
    ]),
  );
  targetVars = asVariables(
    railwayJson([
      'variables',
      '--project',
      projectId,
      '--service',
      targetService,
      '--environment',
      environment,
      '--json',
    ]),
  );
} catch {
  console.error(
    `Sync BLOCKED for ${environment}: could not read Railway variables; values not printed.`,
  );
  process.exit(1);
}

const toSet = [];
for (const key of KEYS) {
  if (!present(sourceVars, key, minLen[key])) {
    console.error(
      `Sync BLOCKED for ${environment}: source ${sourceService} missing/invalid ${key}; values not printed.`,
    );
    process.exit(1);
  }
  if (present(targetVars, key, minLen[key])) {
    console.log(`OK ${environment}/${targetService}: ${key} already present`);
    continue;
  }
  toSet.push(key);
  console.log(`SYNC ${environment}/${targetService}: ${key} from ${sourceService}`);
}

if (toSet.length === 0) {
  console.log(
    `Sync SKIP for ${environment}/${targetService}: required keys already present; values not printed.`,
  );
  process.exit(0);
}

try {
  const args = [
    'variables',
    '--project',
    projectId,
    '--service',
    targetService,
    '--environment',
    environment,
    '--skip-deploys',
  ];
  for (const key of toSet) {
    args.push('--set', `${key}=${sourceVars[key]}`);
  }
  execFileSync('railway', args, {
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024,
  });
} catch {
  console.error(
    `Sync BLOCKED for ${environment}/${targetService}: railway set failed; values not printed.`,
  );
  process.exit(1);
}

console.log(
  `Sync PASS for ${environment}/${targetService}: copied ${toSet.length} key(s); values not printed.`,
);
