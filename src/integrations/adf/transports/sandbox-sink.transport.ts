import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import MailComposer from 'nodemailer/lib/mail-composer';
import {
  buildLeadMailOptions,
  LeadDeliveryTransport,
  LeadTransportError,
  OutboundLeadMessage,
  TransportReceipt,
} from './lead-delivery-transport';

export type SinkRecord = {
  deliveryId: string;
  tenantId: string;
  routeId: string;
  messageId: string;
  from: string;
  to: string;
  subject: string;
  format: string;
  /** Full RFC 5322 message (headers + body). Empty in production — metadata only. */
  raw: string;
  xml: string;
  sha256: string;
  at: Date;
};

const SINK_CAPACITY = 500;

/**
 * Local sink: records the exact message a real transport would send and hands it to nobody.
 * Used for tests, the demo, and as the forced transport whenever live mode is not fully gated.
 */
@Injectable()
export class SandboxSinkTransport implements LeadDeliveryTransport {
  readonly name = 'sandbox-sink';
  private readonly records: SinkRecord[] = [];

  async send(message: OutboundLeadMessage): Promise<TransportReceipt> {
    // Defence in depth behind the `sandbox_in_production` gate: production never records a
    // lead in the sink, so a real lead can never look "accepted" without having been sent.
    if (process.env.NODE_ENV === 'production')
      throw new LeadTransportError('sandbox_in_production', false);
    const options = buildLeadMailOptions(message);
    const raw = (await new MailComposer(options).compile().build()).toString(
      'utf8',
    );
    const sha256 = createHash('sha256').update(message.xml).digest('hex');
    // Production keeps metadata only: a sink must never become a store of customer data.
    const keepBody = process.env.NODE_ENV !== 'production';
    const record: SinkRecord = {
      deliveryId: message.deliveryId,
      tenantId: message.tenantId,
      routeId: message.routeId,
      messageId: options.messageId,
      from: options.from,
      to: options.to,
      subject: options.subject,
      format: message.format,
      raw: keepBody ? raw : '',
      xml: keepBody ? message.xml : '',
      sha256,
      at: new Date(),
    };
    this.records.push(record);
    if (this.records.length > SINK_CAPACITY) this.records.shift();
    const dir = process.env.ADF_SANDBOX_SINK_DIR?.trim();
    if (dir && keepBody) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(
          dir,
          `${message.deliveryId.replace(/[^A-Za-z0-9_-]/g, '_')}.eml`,
        ),
        raw,
        { mode: 0o600 },
      );
    }
    return {
      accepted: true,
      providerName: this.name,
      providerMessageId: `sink-${sha256.slice(0, 24)}`,
      rawStatus: 'sandbox_sink_recorded',
      at: record.at,
    };
  }

  messages(): ReadonlyArray<SinkRecord> {
    return this.records;
  }

  clear(): void {
    this.records.length = 0;
  }
}
