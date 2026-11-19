import { Injectable } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { isLoopbackHost } from '../destination';
import {
  deliveryTier,
  LeadDeliveryEnv,
  readLeadDeliveryEnv,
} from '../lead-delivery-gates';
import {
  buildLeadMailOptions,
  LeadDeliveryTransport,
  LeadTransportError,
  OutboundLeadMessage,
  sanitizeProviderStatus,
  SEND_DEADLINE_CODE,
  TransportContext,
  TransportReceipt,
} from './lead-delivery-transport';

/**
 * The SMTP transport refuses any non-loopback host unless live mode is fully gated on. Pure so
 * the policy is unit-tested without opening a socket.
 */
export function assertSmtpTargetAllowed(host: string, live: boolean): void {
  if (!live && !isLoopbackHost(host))
    throw new LeadTransportError('smtp_host_not_loopback', false);
}

/** Map a nodemailer/SMTP failure to a PII-free code + retryability. */
export function classifySmtpError(err: unknown): LeadTransportError {
  if (err instanceof LeadTransportError) return err;
  const e = (err ?? {}) as { responseCode?: unknown; code?: unknown };
  const rc = typeof e.responseCode === 'number' ? e.responseCode : 0;
  if (rc >= 500 && rc < 600)
    return new LeadTransportError(`smtp_rejected_${rc}`, false);
  if (rc >= 400 && rc < 500)
    return new LeadTransportError(`smtp_deferred_${rc}`, true);
  const code = typeof e.code === 'string' ? e.code : '';
  if (code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'ECONNECTION')
    return new LeadTransportError(`smtp_${code.toLowerCase()}`, true);
  if (code === 'EAUTH')
    return new LeadTransportError('smtp_auth_failed', false);
  if (code === 'EENVELOPE')
    return new LeadTransportError('smtp_envelope_rejected', false);
  return new LeadTransportError('smtp_error', true);
}

/**
 * Real RFC 5322 mail over SMTP via nodemailer (MIT-0). nodemailer generates the MIME structure;
 * every header-bound value is pre-validated by buildLeadMailOptions.
 */
@Injectable()
export class SmtpLeadTransport implements LeadDeliveryTransport {
  readonly name = 'smtp';

  async send(
    message: OutboundLeadMessage,
    ctx: TransportContext,
    env: LeadDeliveryEnv = readLeadDeliveryEnv(),
  ): Promise<TransportReceipt> {
    assertSmtpTargetAllowed(env.smtp.host, ctx.live);
    // Production either sends live or sends nothing (see the `sandbox_in_production` gate).
    if (!ctx.live && deliveryTier(env) === 'production')
      throw new LeadTransportError('sandbox_in_production', false);
    if (!ctx.live && message.routeEnvironment === 'PRODUCTION')
      throw new LeadTransportError('production_route_in_sandbox', false);
    const options = buildLeadMailOptions(message);
    const transport = nodemailer.createTransport({
      host: env.smtp.host,
      port: env.smtp.port,
      secure: env.smtp.secure,
      // Live: never fall back to plaintext. Sandbox: loopback mock only (no TLS offered).
      requireTLS: ctx.live && !env.smtp.secure,
      ignoreTLS: !ctx.live,
      auth:
        env.smtp.user && env.smtp.pass
          ? { user: env.smtp.user, pass: env.smtp.pass }
          : undefined,
      connectionTimeout: 8_000,
      greetingTimeout: 8_000,
      socketTimeout: 15_000,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    // ONE hard deadline for the whole exchange. The per-phase timeouts above only bound idle
    // phases; a server that trickles data could otherwise hold a send open past the stale-SENT
    // window. On the deadline the connection is aborted, so no late success can follow.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), env.sendDeadlineMs);
    try {
      const info = await transport.sendMail({
        ...options,
        signal: abort.signal,
      });
      const accepted =
        Array.isArray(info.accepted) &&
        info.accepted.length === 1 &&
        (!Array.isArray(info.rejected) || info.rejected.length === 0);
      if (!accepted)
        throw new LeadTransportError('smtp_recipient_not_accepted', false);
      return {
        accepted: true,
        providerName: this.name,
        providerMessageId:
          typeof info.messageId === 'string' ? info.messageId : null,
        rawStatus: sanitizeProviderStatus(info.response),
        at: new Date(),
      };
    } catch (err) {
      if (abort.signal.aborted)
        throw new LeadTransportError(SEND_DEADLINE_CODE, true);
      throw classifySmtpError(err);
    } finally {
      clearTimeout(timer);
      transport.close();
    }
  }
}
