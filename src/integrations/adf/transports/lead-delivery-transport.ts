import { assertHeaderSafe, normalizeDestination } from '../destination';

export type LeadMessageFormat = 'XML_BODY' | 'XML_ATTACHMENT';

/** Everything a transport needs. `xml` is the validated ADF document. */
export type OutboundLeadMessage = {
  deliveryId: string;
  tenantId: string;
  routeId: string;
  /** The route's environment; a sandbox transport refuses anything but SANDBOX. */
  routeEnvironment?: 'SANDBOX' | 'PRODUCTION';
  correlationId: string;
  messageId: string;
  from: string;
  to: string;
  subject: string;
  xml: string;
  format: LeadMessageFormat;
  date: Date;
};

/** Typed receipt. `accepted` means the transport acknowledged — NOT delivered, NOT in a CRM. */
export type TransportReceipt = {
  accepted: boolean;
  providerName: string;
  providerMessageId: string | null;
  rawStatus: string;
  at: Date;
};

export type TransportContext = {
  /** True only when every live gate is open (see effectiveMode + evaluateSendGates). */
  live: boolean;
};

export interface LeadDeliveryTransport {
  readonly name: string;
  send(
    message: OutboundLeadMessage,
    ctx: TransportContext,
  ): Promise<TransportReceipt>;
}

/** Error code of a hand-off that hit the hard overall send deadline (retryable). */
export const SEND_DEADLINE_CODE = 'send_deadline_exceeded';

/** `code` is PII-free and safe for logs, outbox errors and metrics. */
export class LeadTransportError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(code);
  }
}

export type LeadMailOptions = {
  messageId: string;
  date: Date;
  from: string;
  to: string;
  envelope: { from: string; to: string[] };
  subject: string;
  text: string;
  headers: Record<string, string>;
  attachments?: Array<{
    filename: string;
    content: string;
    contentType: string;
  }>;
  disableFileAccess: true;
  disableUrlAccess: true;
};

/**
 * Pure RFC 5322 message description shared by every transport. Rejects CR/LF or any control
 * character in every header-bound value (header-injection safe) and insists on exactly one bare
 * recipient mailbox — there is no CC/BCC path at all.
 */
export function buildLeadMailOptions(m: OutboundLeadMessage): LeadMailOptions {
  const from = normalizeDestination(assertHeaderSafe('from', m.from));
  const to = normalizeDestination(assertHeaderSafe('to', m.to));
  if (!from) throw new LeadTransportError('bad_from_address', false);
  if (!to) throw new LeadTransportError('bad_recipient_address', false);
  const messageId = assertHeaderSafe('messageId', m.messageId);
  if (!/^<[A-Za-z0-9._-]+@[A-Za-z0-9.-]+>$/.test(messageId))
    throw new LeadTransportError('bad_message_id', false);
  const subject = assertHeaderSafe('subject', m.subject);
  if (subject.length === 0 || subject.length > 200)
    throw new LeadTransportError('bad_subject', false);
  const headers = {
    'X-AMQUR-Delivery-Id': assertHeaderSafe('deliveryId', m.deliveryId),
    'X-AMQUR-Correlation-Id': assertHeaderSafe(
      'correlationId',
      m.correlationId,
    ),
    'Auto-Submitted': 'auto-generated',
  };
  if (!(m.date instanceof Date) || Number.isNaN(m.date.getTime()))
    throw new LeadTransportError('bad_date', false);
  const base = {
    messageId,
    date: m.date,
    from,
    to,
    envelope: { from, to: [to] },
    subject,
    headers,
    disableFileAccess: true as const,
    disableUrlAccess: true as const,
  };
  if (m.format === 'XML_ATTACHMENT')
    return {
      ...base,
      text: 'ADF 1.0 lead attached (lead.adf.xml).',
      attachments: [
        {
          filename: 'lead.adf.xml',
          content: m.xml,
          contentType: 'application/xml; charset=utf-8',
        },
      ],
    };
  return { ...base, text: m.xml };
}

/** Strip anything address-like from a provider status line before it is stored or logged. */
export function sanitizeProviderStatus(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : '';
  return (
    s
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001F\u007F]+/g, ' ')
      .replace(/<[^>]*>/g, '<redacted>')
      .replace(/\S+@\S+/g, '<redacted>')
      .trim()
      .slice(0, 160) || 'no_status'
  );
}
