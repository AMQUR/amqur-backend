import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const script = join(dirname(fileURLToPath(import.meta.url)), 'production-release-gate.mjs');
const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const sha = '0123456789abcdef0123456789abcdef01234567';
const valid = {
  GITHUB_SHA: sha,
  AMQUR_PRODUCTION_APPROVED_SHA: sha,
  AMQUR_BACKUP_RESTORE_RECEIPT: 'railway-backup-restore-report-20261107',
  AMQUR_BACKUP_RESTORE_AT: now,
  AMQUR_ALERT_DELIVERY_RECEIPT: 'sentry-alert-delivery-confirmation-20261107',
  AMQUR_ALERT_DELIVERY_AT: now,
};
function check(changes = {}) {
  return spawnSync(process.execPath, [script], {
    env: { ...process.env, ...valid, ...changes },
    encoding: 'utf8',
  });
}
test('accepts only fully supplied fresh approval and references, without logging values', () => {
  const r = check();
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /railway-backup-restore-report|sentry-alert-delivery-confirmation/);
});
for (const [name, value] of [
  ['AMQUR_PRODUCTION_APPROVED_SHA', '0000000000000000000000000000000000000000'],
  ['AMQUR_BACKUP_RESTORE_RECEIPT', ''],
  ['AMQUR_ALERT_DELIVERY_RECEIPT', 'pending'],
  ['AMQUR_BACKUP_RESTORE_AT', '2020-01-01T00:00:00Z'],
  ['AMQUR_ALERT_DELIVERY_AT', '2040-01-01T00:00:00Z'],
  ['GITHUB_SHA', 'abc123'],
  ['AMQUR_BACKUP_RESTORE_AT', 'not-a-date'],
  ['AMQUR_ALERT_DELIVERY_RECEIPT', valid.AMQUR_BACKUP_RESTORE_RECEIPT],
]) {
  test('denies invalid or missing ' + name, () => {
    const r = check({ [name]: value });
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(r.stderr, /DENIED/);
  });
}
