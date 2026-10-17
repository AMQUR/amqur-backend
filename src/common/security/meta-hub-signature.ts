import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Meta (Facebook) webhook signing for Lead Ads and other Graph subscriptions.
 *
 *   header X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of raw body using App Secret>
 *
 * Use the exact raw request bytes Meta signed — never re-serialized JSON.
 * Env: META_APP_SECRET (App Secret from Meta developer app settings).
 */
export const META_HUB_SIGNATURE_HEADER = 'x-hub-signature-256';

export type VerifyMetaHubResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'not_configured'
        | 'missing_headers'
        | 'malformed'
        | 'bad_signature';
    };

export function verifyMetaHubSignature256(params: {
  rawBody: string | Buffer;
  signatureHeader?: string | null;
  appSecret?: string | null;
}): VerifyMetaHubResult {
  const secret = params.appSecret?.trim();
  if (!secret) return { ok: false, reason: 'not_configured' };
  const header = params.signatureHeader?.trim();
  if (!header) return { ok: false, reason: 'missing_headers' };
  const prefix = 'sha256=';
  if (!header.toLowerCase().startsWith(prefix)) {
    return { ok: false, reason: 'malformed' };
  }
  const providedHex = header.slice(prefix.length);
  if (!/^[0-9a-fA-F]{64}$/.test(providedHex)) {
    return { ok: false, reason: 'malformed' };
  }
  const expectedHex = createHmac('sha256', secret)
    .update(params.rawBody)
    .digest('hex');
  const expected = Buffer.from(expectedHex, 'hex');
  const provided = Buffer.from(providedHex.toLowerCase(), 'hex');
  if (
    expected.length !== provided.length ||
    !timingSafeEqual(expected, provided)
  ) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true };
}
