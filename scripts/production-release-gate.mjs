#!/usr/bin/env node
/**
 * Fail-closed production deployment gate.
 *
 * GitHub production ENVIRONMENT variables must contain independently reviewed
 * evidence references, fresh UTC verification dates, and approval of the exact
 * merge/deploy SHA. This script never validates the underlying provider data:
 * an operator must inspect the backup restore and delivered alert receipts.
 * Only NON-SECRET reference IDs are expected. Never print variable values.
 */
const variables = process.env;
const now = Date.now();
const day = 24 * 60 * 60 * 1000;
const failures = [];
function check(name, valid) {
  if (!valid) failures.push(name);
  console.log(`${valid ? 'OK' : 'BLOCKED'} production-release: ${name}`);
}
function evidence(value) {
  const v = String(value ?? '').trim();
  return v.length >= 16 && v.length <= 255 &&
    /^[A-Za-z0-9][A-Za-z0-9_./:#-]*$/.test(v) &&
    !/^(?:todo|pending|none|missing|unknown|fake|placeholder|not[-_ ]?verified)/i.test(v);
}
function recentUtc(value) {
  const v = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(v)) return false;
  const timestamp = Date.parse(v);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().replace('.000Z', 'Z') === v &&
    timestamp <= now + 5 * 60 * 1000 && timestamp >= now - 30 * day;
}
const commit = String(variables.GITHUB_SHA ?? '').trim().toLowerCase();
const approved = String(variables.AMQUR_PRODUCTION_APPROVED_SHA ?? '').trim().toLowerCase();
const backup = String(variables.AMQUR_BACKUP_RESTORE_RECEIPT ?? '').trim();
const alert = String(variables.AMQUR_ALERT_DELIVERY_RECEIPT ?? '').trim();
check('exact approved release SHA', /^[a-f0-9]{40}$/.test(commit) && approved === commit);
check('independent backup + isolated restore receipt', evidence(backup));
check('backup restore UTC verification (30 days)', recentUtc(variables.AMQUR_BACKUP_RESTORE_AT));
check('delivered monitoring alert receipt', evidence(alert) && alert !== backup);
check('monitoring alert UTC verification (30 days)', recentUtc(variables.AMQUR_ALERT_DELIVERY_AT));
if (failures.length) {
  console.error('Production promotion DENIED: required operator-verified evidence is missing or stale. No receipt values were logged.');
  process.exitCode = 1;
} else {
  console.log('Production promotion gate preflight PASS: references and freshness supplied; verify actual source receipts separately.');
}
