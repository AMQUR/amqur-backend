/**
 * Self-tests for staging generative canary helpers (no network).
 * Run: node --test scripts/staging-generative-canary.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { matchesExpectedCommit, isApprovedStagingEndpoint, isGenerativeConfigured } from './staging-canary-guards.mjs';

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

describe('release attestation regression tests', () => {
  it('accepts actual full SHA or valid matching abbreviated SHA', () => {
    const full = '9f28a87e068935bbd6d27ff796d6a84f89f8248f';
    assert.equal(matchesExpectedCommit(full, full), true);
    assert.equal(matchesExpectedCommit(full, '9f28a87'), true);
    assert.equal(matchesExpectedCommit('9f28a87', full), true);
  });

  it('rejects empty, missing, malformed or mismatching deployed SHAs', () => {
    const full = '9f28a87e068935bbd6d27ff796d6a84f89f8248f';
    for (const actual of ['', null, undefined, 'n/a', '9f28', 'aaaaaaaa']) {
      assert.equal(matchesExpectedCommit(actual, full), false, String(actual));
    }
    assert.equal(matchesExpectedCommit(full, ''), false);
    assert.equal(matchesExpectedCommit(full, '9f28a8z'), false);
  });

  it('refuses production, lookalike, HTTP, credentialed, and unknown endpoints', () => {
    assert.equal(isApprovedStagingEndpoint('https://staging-api.dialusnow.com'), true);
    assert.equal(isApprovedStagingEndpoint('https://staging-api.dialusnow.com/'), true);
    for (const url of [
      'https://api.dialusnow.com',
      'https://staging-api.dialusnow.com.evil.example',
      'https://prod-api.up.railway.app',
      'http://staging-api.dialusnow.com',
      'https://user:password@staging-api.dialusnow.com',
      'https://staging-api.dialusnow.com/api',
      'https://staging-api.dialusnow.com/?environment=production',
      'bad-url',
    ]) assert.equal(isApprovedStagingEndpoint(url), false, url);
  });

  it('never treats safety-only or unknown LLM health as model attestation', () => {
    assert.equal(isGenerativeConfigured('configured'), true);
    for (const health of ['missing', 'disabled', 'error', null, undefined]) {
      assert.equal(isGenerativeConfigured(health), false);
    }
  });

  it('wires strict release guards into live canary source', () => {
    assert.match(src, /matchesExpectedCommit\(shaBefore, EXPECTED_SHA\)/);
    assert.match(src, /matchesExpectedCommit\(shaAfter, EXPECTED_SHA\)/);
    assert.match(src, /isApprovedStagingEndpoint\(apiBase\)/);
    assert.match(src, /generative-gate: llm must be configured/);
  });
});
