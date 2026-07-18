import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRefreshBody,
  extractAccessToken,
  extractRefreshToken,
  unwrapAuthPayload,
} from './extract-auth-tokens.mjs';

test('snake_case wrapped by ResponseInterceptor', () => {
  const body = {
    success: true,
    statusCode: 201,
    data: {
      access_token: 'acc-snake',
      refresh_token: 'ref-snake',
    },
  };
  assert.equal(extractRefreshToken(body), 'ref-snake');
  assert.equal(extractAccessToken(body), 'acc-snake');
  assert.deepEqual(JSON.parse(buildRefreshBody(extractRefreshToken(body))), {
    refresh_token: 'ref-snake',
  });
});

test('camelCase legacy', () => {
  const body = {
    data: { accessToken: 'acc-cam', refreshToken: 'ref-cam' },
  };
  assert.equal(extractRefreshToken(body), 'ref-cam');
  assert.equal(extractAccessToken(body), 'acc-cam');
});

test('nested tokens object', () => {
  const body = {
    data: {
      tokens: {
        access_token: 'acc-nest',
        refresh_token: 'ref-nest',
      },
    },
  };
  assert.equal(extractRefreshToken(body), 'ref-nest');
  assert.equal(extractAccessToken(body), 'acc-nest');
});

test('double-wrapped data.data', () => {
  const body = {
    data: {
      data: { refresh_token: 'ref-double', access_token: 'acc-double' },
    },
  };
  assert.equal(unwrapAuthPayload(body).refresh_token, 'ref-double');
  assert.equal(extractRefreshToken(body), 'ref-double');
});

test('missing tokens return empty string', () => {
  assert.equal(extractRefreshToken({ data: {} }), '');
  assert.equal(extractRefreshToken(null), '');
});
