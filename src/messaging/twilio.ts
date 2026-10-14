import { createHash, createHmac, timingSafeEqual } from 'crypto';

/**
 * Twilio request validation per https://www.twilio.com/docs/usage/security:
 *  - form posts: base64(HMAC-SHA1(authToken, fullUrl + Σ sorted(name+value)))
 *  - JSON posts: URL carries bodySHA256 = sha256(rawBody); signature over the URL only
 * The exact URL Twilio called (including query string, as-encoded) must be used.
 */
export function twilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string> = {},
): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], url);
  return createHmac('sha1', authToken)
    .update(Buffer.from(data, 'utf-8'))
    .digest('base64');
}

export function validateTwilioRequest(p: {
  authToken: string;
  url: string;
  signature: string | undefined;
  params?: Record<string, string>;
  rawJsonBody?: string;
}): boolean {
  if (!p.signature || !p.authToken) return false;
  let params = p.params ?? {};
  if (p.rawJsonBody !== undefined) {
    const u = new URL(p.url);
    const declared = u.searchParams.get('bodySHA256');
    const actual = createHash('sha256').update(p.rawJsonBody).digest('hex');
    if (!declared || declared !== actual) return false;
    params = {};
  }
  const expected = Buffer.from(twilioSignature(p.authToken, p.url, params));
  const got = Buffer.from(p.signature);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

export type TwilioCredentials = {
  accountSid: string;
  authToken: string;
  messagingServiceSid: string;
};

export type SendResult =
  | { ok: true; providerMessageId: string; status: string }
  | { ok: false; error: string; optedOut: boolean; retryable: boolean };

/** Official REST: POST /2010-04-01/Accounts/{AccountSid}/Messages.json (form-encoded, basic auth). */
export async function twilioSendSms(
  creds: TwilioCredentials,
  msg: { to: string; body: string; statusCallback?: string },
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<SendResult> {
  const form = new URLSearchParams({
    To: msg.to,
    Body: msg.body,
    MessagingServiceSid: creds.messagingServiceSid,
  });
  if (msg.statusCallback) form.set('StatusCallback', msg.statusCallback);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    // Test stacks may point at a local fake; production always uses the official host.
    const base =
      process.env.NODE_ENV !== 'production' && process.env.TWILIO_API_BASE
        ? process.env.TWILIO_API_BASE
        : 'https://api.twilio.com';
    const res = await fetchImpl(
      `${base}/2010-04-01/Accounts/${encodeURIComponent(creds.accountSid)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
        signal: ctl.signal,
      },
    );
    const json = (await res.json().catch(() => ({}))) as {
      sid?: string;
      status?: string;
      code?: number;
      message?: string;
    };
    if (res.ok && json.sid)
      return {
        ok: true,
        providerMessageId: json.sid,
        status: json.status ?? 'queued',
      };
    const code = json.code ?? res.status;
    // 21610 / 30630: recipient unsubscribed (STOP) — permanent, record suppression.
    const optedOut = code === 21610 || code === 30630;
    return {
      ok: false,
      error: `twilio_${code}`,
      optedOut,
      retryable: !optedOut && (res.status >= 500 || res.status === 429),
    };
  } catch (e) {
    return {
      ok: false,
      error:
        e instanceof Error && e.name === 'AbortError'
          ? 'twilio_timeout'
          : 'twilio_network',
      optedOut: false,
      retryable: true,
    };
  } finally {
    clearTimeout(t);
  }
}
