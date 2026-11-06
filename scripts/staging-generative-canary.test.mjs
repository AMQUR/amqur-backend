/**
 * Self-tests for staging generative canary helpers (no network).
 * Run: node --test scripts/staging-generative-canary.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'staging-generative-canary.mjs'), 'utf8');

describe('staging-generative-canary contract', () => {
  it('requires EXPECTED_COMMIT_SHA', () => {
    assert.match(src, /EXPECTED_COMMIT_SHA/);
    assert.match(src, /EXPECTED_COMMIT_SHA required/);
  });

  it('refuses production API hosts', () => {
    assert.match(src, /api\.dialusnow\.com/);
    assert.match(src, /production API host is not allowed/);
  });

  it('requires per-tenant accepted model replies when llm configured', () => {
    assert.match(src, /perTenantModel/);
    assert.match(src, /zero accepted model replies/);
    assert.match(src, /all \$\{TENANTS\.length\} tenants/);
  });

  it('accepts only polished|answered|composed|repaired as generative success', () => {
    assert.match(src, /polished/);
    assert.match(src, /answered/);
    assert.match(src, /composed/);
    assert.match(src, /repaired/);
    assert.match(src, /ACCEPTED_LM/);
  });

  it('rejects interpretation-only as generative proof', () => {
    assert.match(src, /interpretation-only/);
  });

  it('verifies SHA before and after the run', () => {
    assert.match(src, /sha-before/);
    assert.match(src, /sha-after/);
  });

  it('classifies provider failure categories', () => {
    assert.match(src, /classifyProviderFailure/);
    assert.match(src, /redis_spend_store/);
    assert.match(src, /circuit_breaker/);
    assert.match(src, /invalid_credentials/);
  });

  it('labels safety-only mode when llm is not configured', () => {
    assert.match(src, /MODE=safety-only/);
    assert.match(src, /NOT generative verification/);
  });

  it('never prints tokens in source', () => {
    assert.doesNotMatch(src, /console\.log\([^)]*token[^)]*\)/i);
  });

  it('includes five staging tenants', () => {
    for (const t of [
      'jeep-of-chicago',
      'dial-nissan-of-chicago',
      'dial-chevy-of-chicago',
      'infiniti-of-chicago',
      'dial-cdjr-of-chicago',
    ]) {
      assert.match(src, new RegExp(t));
    }
  });
});
