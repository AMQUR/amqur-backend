/**
 * Extract access/refresh tokens from AMQUR auth JSON envelopes.
 * Supports snake_case (production), camelCase, and nested tokens objects.
 * Never logs token values.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function unwrapAuthPayload(body) {
  if (!body || typeof body !== 'object') return {};
  // ResponseInterceptor wraps as { success, statusCode, data, timestamp }
  if (body.data != null && typeof body.data === 'object') {
    if (body.data.data != null && typeof body.data.data === 'object') {
      return body.data.data;
    }
    return body.data;
  }
  return body;
}

export function extractRefreshToken(body) {
  const d = unwrapAuthPayload(body);
  return (
    d.refresh_token ||
    d.refreshToken ||
    d.tokens?.refresh_token ||
    d.tokens?.refreshToken ||
    ''
  );
}

export function extractAccessToken(body) {
  const d = unwrapAuthPayload(body);
  return (
    d.access_token ||
    d.accessToken ||
    d.tokens?.access_token ||
    d.tokens?.accessToken ||
    ''
  );
}

export function buildRefreshBody(refreshToken) {
  // RefreshDto expects snake_case refresh_token
  return JSON.stringify({ refresh_token: refreshToken });
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const [, , file, mode = 'refresh'] = process.argv;
  if (!file) {
    process.stderr.write(
      'usage: extract-auth-tokens.mjs <json-file> [refresh|access|refresh-body|has-refresh]\n',
    );
    process.exit(2);
  }
  const body = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (mode === 'access') {
    process.stdout.write(extractAccessToken(body));
  } else if (mode === 'refresh-body') {
    const r = extractRefreshToken(body);
    if (!r) process.exit(3);
    process.stdout.write(buildRefreshBody(r));
  } else if (mode === 'has-refresh') {
    process.stdout.write(extractRefreshToken(body) ? '1' : '0');
  } else {
    process.stdout.write(extractRefreshToken(body));
  }
}
