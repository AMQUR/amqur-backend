/** Canonical inbound message for omnichannel — channel-agnostic business core. */
export type InboundChannelMessage = {
  tenantId: string;
  locationId?: string | null;
  channel:
    | 'WIDGET'
    | 'SMS'
    | 'EMAIL'
    | 'WHATSAPP'
    | 'MESSENGER'
    | 'INSTAGRAM'
    | 'VOICE'
    | 'GOOGLE_BUSINESS'
    | 'STAFF';
  externalConversationId: string;
  externalMessageId?: string | null;
  customerIdentity?: {
    name?: string | null;
    email?: string | null;
    phone?: string | null;
    crmCustomerId?: string | null;
  };
  text: string;
  attachments?: Array<{ url: string; contentType?: string; name?: string }>;
  selectedVin?: string | null;
  language?: string | null;
  consent?: {
    sms?: boolean;
    email?: boolean;
    call?: boolean;
  };
  receivedAt: string;
  metadata?: Record<string, unknown>;
};

export type OutboundChannelMessage = {
  tenantId: string;
  locationId?: string | null;
  channel: InboundChannelMessage['channel'];
  externalConversationId: string;
  text: string;
  structured?: Record<string, unknown>;
  deliveryStatus: 'PENDING' | 'SENT' | 'FAILED' | 'SUPPRESSED';
  suppressReason?: string | null;
};

export interface MessagingProvider {
  readonly providerId: string;
  readonly channel: InboundChannelMessage['channel'];
  isLiveConfigured(): boolean;
  send(message: OutboundChannelMessage): Promise<{ ok: boolean; externalId?: string }>;
}
