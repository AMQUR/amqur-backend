import { createHmac, timingSafeEqual } from 'crypto';

/**
 * AMQUR-owned generic webhook signing (inbound + outbound).
 *
 *   signed string = `${timestamp}.${eventId}.${rawBody}`   (raw bytes as sent — never re-serialized JSON)
 *   header x-amqur-signature: v1=<hex HMAC-SHA256>[,v1=<hex for rotated secret>]
 *   header x-amqur-timestamp: unix seconds
 *   header x-amqur-event-id:  unique event id (replay key, stored in WebhookInbox)
 *
 * Provider webhooks (Twilio, Tekion, …) MUST use the provider's official scheme instead.
 */
export const SIGNATURE_HEADER = 'x-amqur-signature';
export const TIMESTAMP_HEADER = 'x-amqur-timestamp';
export const EVENT_ID_HEADER = 'x-amqur-event-id';
export const DEFAULT_TOLERANCE_SECONDS = 300;

function hmac(
  secret: string,
  ts: string,
  eventId: string,
  raw: string | Buffer,
): string {
  const h = createHmac('sha256', secret);
  h.update(`${ts}.${eventId}.`);
  h.update(raw);
  return h.digest('hex');
}

export function signWebhookPayload(
  rawBody: string | Buffer,
  secret: string,
  eventId: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const ts = String(nowSeconds);
  return {
    [SIGNATURE_HEADER]: `v1=${hmac(secret, ts, eventId, rawBody)}`,
    [TIMESTAMP_HEADER]: ts,
    [EVENT_ID_HEADER]: eventId,
  };
}

export type VerifyResult =
  | { ok: true; secretIndex: number }
  | {
      ok: false;
      reason:
        | 'missing_headers'
        | 'no_secret_configured'
        | 'timestamp_out_of_tolerance'
        | 'bad_signature'
        | 'malformed';
    };

/**
 * Verify with constant-time comparison. `secrets` supports rotation: current first,
 * previous second. Never logs or returns secret material.
 */
export function verifyWebhookSignature(params: {
  rawBody: string | Buffer;
  signatureHeader?: string | null;
  timestampHeader?: string | null;
  eventId?: string | null;
  secrets: Array<string | null | undefined>;
  toleranceSeconds?: number;
  nowSeconds?: number;
}): VerifyResult {
  const secrets = params.secrets.filter(
    (s): s is string => !!s && s.length >= 16,
  );
  if (secrets.length === 0)
    return { ok: false, reason: 'no_secret_configured' };
  if (!params.signatureHeader || !params.timestampHeader || !params.eventId) {
    return { ok: false, reason: 'missing_headers' };
  }
  if (!/^\d{9,11}$/.test(params.timestampHeader))
    return { ok: false, reason: 'malformed' };
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tol = params.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(now - Number(params.timestampHeader)) > tol) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' };
  }
  const provided = params.signatureHeader
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.startsWith('v1='))
    .map((p) => p.slice(3))
    .filter((p) => /^[0-9a-f]{64}$/.test(p));
  if (provided.length === 0) return { ok: false, reason: 'malformed' };
  for (let i = 0; i < secrets.length; i += 1) {
    const expected = Buffer.from(
      hmac(secrets[i], params.timestampHeader, params.eventId, params.rawBody),
      'hex',
    );
    for (const sig of provided) {
      const got = Buffer.from(sig, 'hex');
      if (got.length === expected.length && timingSafeEqual(got, expected)) {
        return { ok: true, secretIndex: i };
      }
    }
  }
  return { ok: false, reason: 'bad_signature' };
}

/**
 * Strict base64url decode for signatures: rejects anything whose re-encoding differs from the
 * input. Node's decoder silently ignores unused trailing bits and invalid characters, which
 * would let several distinct strings verify as the same MAC (signature malleability).
 */
export function decodeCanonicalBase64Url(s: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const buf = Buffer.from(s, 'base64url');
  return buf.toString('base64url') === s ? buf : null;
}
