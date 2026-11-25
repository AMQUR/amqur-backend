import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { LeadDeliveryEnv, readLeadDeliveryEnv } from '../lead-delivery-gates';
import {
  buildLeadMailOptions,
  LeadDeliveryTransport,
  LeadTransportError,
  OutboundLeadMessage,
  SEND_DEADLINE_CODE,
  TransportContext,
  TransportReceipt,
} from './lead-delivery-transport';

export const RESEND_API_ORIGIN = 'https://api.resend.com';
const EMAIL_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{ status: number; json(): Promise<unknown> }>;

/** `email_id=<uuid>` inside a stored provider status line, or null. */
export function resendEmailIdFromStatus(
  raw: string | null | undefined,
): string | null {
  const m = /email_id=([0-9a-f-]{36})\b/i.exec(raw ?? '');
  return m && EMAIL_ID.test(m[1]) ? m[1].toLowerCase() : null;
}

/**
 * Stable per delivery AND payload: a retry of the same document is de-duplicated by Resend
 * (24 h window); a changed document gets a new key instead of a 409.
 */
export function resendIdempotencyKey(m: {
  deliveryId: string;
  xml: string;
}): string {
  const digest = createHash('sha256').update(m.xml).digest('hex').slice(0, 32);
  return `lead-delivery/${m.deliveryId}/${digest}`;
}

/** The exact JSON body sent to POST /emails. Pure, so the MIME shape is unit-tested. */
export function buildResendPayload(m: OutboundLeadMessage) {
  const o = buildLeadMailOptions(m);
  return {
    from: o.from,
    to: [o.to],
    subject: o.subject,
    // Plain text only: no HTML part, so nothing rewrites or wraps the ADF document.
    text: o.text,
    headers: { ...o.headers, 'X-AMQUR-Message-Id': o.messageId },
    ...(o.attachments
      ? {
          attachments: o.attachments.map((a) => ({
            filename: a.filename,
            content: Buffer.from(a.content, 'utf8').toString('base64'),
            contentType: a.contentType,
          })),
        }
      : {}),
  };
}

/** Map a Resend HTTP status to a PII-free code + retryability. */
export function classifyResendStatus(status: number): LeadTransportError {
  if (status === 401 || status === 403)
    return new LeadTransportError('resend_auth_failed', false);
  if (status === 409)
    return new LeadTransportError('resend_conflict_409', true);
  if (status === 429)
    return new LeadTransportError('resend_rate_limited', true);
  if (status >= 500)
    return new LeadTransportError(`resend_http_${status}`, true);
  return new LeadTransportError(`resend_rejected_${status}`, false);
}

/**
 * Live lead mail over the Resend HTTPS API (no outbound SMTP port needed). Live only: there is
 * no sandbox path through a real provider. The API key is read from the environment per send
 * and appears in no log line, error, receipt or stored field.
 */
@Injectable()
export class ResendLeadTransport implements LeadDeliveryTransport {
  readonly name = 'resend';

  async send(
    message: OutboundLeadMessage,
    ctx: TransportContext,
    env: LeadDeliveryEnv = readLeadDeliveryEnv(),
    fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ): Promise<TransportReceipt> {
    if (!ctx.live) throw new LeadTransportError('resend_live_only', false);
    if (message.routeEnvironment !== 'PRODUCTION')
      throw new LeadTransportError('resend_requires_production_route', false);
    if (!env.resendApiKey)
      throw new LeadTransportError('resend_not_configured', false);
    const payload = buildResendPayload(message);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), env.sendDeadlineMs);
    try {
      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await fetchImpl(`${RESEND_API_ORIGIN}/emails`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.resendApiKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': resendIdempotencyKey(message),
          },
          body: JSON.stringify(payload),
          signal: abort.signal,
        });
      } catch {
        // Never surface the underlying error: it can carry request details.
        throw new LeadTransportError(
          abort.signal.aborted ? SEND_DEADLINE_CODE : 'resend_network_error',
          true,
        );
      }
      if (res.status < 200 || res.status >= 300)
        throw classifyResendStatus(res.status);
      const body = (await res.json().catch(() => null)) as {
        id?: unknown;
      } | null;
      const id = typeof body?.id === 'string' ? body.id : '';
      if (!EMAIL_ID.test(id))
        throw new LeadTransportError('resend_no_email_id', true);
      return {
        accepted: true,
        providerName: this.name,
        // The durable Message-ID stays the delivery's identifier; Resend's id rides in the status.
        providerMessageId: message.messageId,
        rawStatus: `resend_accepted email_id=${id.toLowerCase()}`,
        at: new Date(),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
