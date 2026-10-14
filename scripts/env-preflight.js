#!/usr/bin/env node
'use strict';

// Deployment guard. Railway variables --json is piped on stdin.
// Never print values: not on success, errors, or malformed input.
const [environment, service] = process.argv.slice(2);
if (!['staging', 'production'].includes(environment) || !['api', 'worker'].includes(service)) {
  console.error('Usage: env-preflight.js <staging|production> <api|worker>');
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
    const entries = current.map((record) => [record?.name ?? record?.key, record?.value]);
    if (entries.some(([key]) => typeof key !== 'string')) throw Error('invalid format');
    return Object.fromEntries(entries);
  }
  if (!current || typeof current !== 'object') throw Error('invalid format');
  return current;
}

function positiveNumber(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function check(vars) {
  const failures = [];
  const status = (name, ok) => {
    console.log((ok ? 'OK' : 'MISSING/INVALID') + ' ' + environment + '/' + service + ': ' + name);
    if (!ok) failures.push(name);
  };
  const present = (name, minLength = 1) =>
    typeof vars[name] === 'string' && vars[name].trim().length >= minLength;

  status('DATABASE_URL', present('DATABASE_URL'));
  status('JWT_SECRET', present('JWT_SECRET', 32));
  // Both environments use the production Docker runtime (NODE_ENV=production).
  status('CORS_ORIGINS', present('CORS_ORIGINS', 8));
  status('INTEGRATION_ENCRYPTION_KEY', present('INTEGRATION_ENCRYPTION_KEY', 32));

  const caps = ['LLM_DAILY_BUDGET_USD', 'LLM_TENANT_DAILY_BUDGET_USD']
    .filter((key) => vars[key] !== undefined && String(vars[key]).trim() !== '');
  for (const key of caps) status(key, positiveNumber(vars[key]) !== null);
  if (caps.length > 0) {
    for (const key of ['LLM_COST_INPUT_PER_MTOK', 'LLM_COST_OUTPUT_PER_MTOK']) {
      status(key, positiveNumber(vars[key]) !== null);
    }
  }
  if (failures.length > 0) {
    console.error('Preflight BLOCKED for ' + environment + '/' + service +
      ': ' + failures.length + ' settings missing/invalid; values not printed.');
    process.exitCode = 1;
  } else {
    console.log('Preflight PASS for ' + environment + '/' + service + '; values not printed.');
  }
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (part) => { raw += part; });
process.stdin.on('end', () => {
  try {
    check(asVariables(JSON.parse(raw)));
  } catch {
    console.error('Preflight BLOCKED for ' + environment + '/' + service +
      ': invalid JSON/format; values not printed.');
    process.exitCode = 1;
  }
});
