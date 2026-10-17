import { videoMessagingAdapter } from './video-messaging.adapter';

/**
 * Omnichannel outbound adapters. Until Meta/WhatsApp/email/video providers are wired,
 * every adapter is honestly `not_connected` and never reports delivery.
 */
export const OMNICHANNEL_ADAPTER_CHANNELS = [
  'WHATSAPP',
  'FACEBOOK_MESSENGER',
  'INSTAGRAM',
  'EMAIL',
  'VIDEO',
] as const;

export type OmnichannelAdapterChannel =
  (typeof OMNICHANNEL_ADAPTER_CHANNELS)[number];

export type ChannelAdapterConnectionStatus = 'not_connected';

export type ChannelSendSuppressedReason = 'provider_not_configured';

export type ChannelSendResult = {
  status: 'SUPPRESSED';
  reason: ChannelSendSuppressedReason;
};

export type ChannelSendParams = {
  tenantId: string;
  locationId?: string | null;
  to: string;
  body: string;
  conversationId?: string | null;
};

export interface ChannelAdapter {
  readonly channel: OmnichannelAdapterChannel;
  readonly status: ChannelAdapterConnectionStatus;
  /** Never queues or invents SENT/DELIVERED — fail closed when not connected. */
  send(_params: ChannelSendParams): Promise<ChannelSendResult>;
}

function notConnectedAdapter(
  channel: OmnichannelAdapterChannel,
): ChannelAdapter {
  return {
    channel,
    status: 'not_connected',
    async send() {
      return { status: 'SUPPRESSED', reason: 'provider_not_configured' };
    },
  };
}

export const CHANNEL_ADAPTER_REGISTRY: Readonly<
  Record<OmnichannelAdapterChannel, ChannelAdapter>
> = {
  WHATSAPP: notConnectedAdapter('WHATSAPP'),
  FACEBOOK_MESSENGER: notConnectedAdapter('FACEBOOK_MESSENGER'),
  INSTAGRAM: notConnectedAdapter('INSTAGRAM'),
  EMAIL: notConnectedAdapter('EMAIL'),
  VIDEO: videoMessagingAdapter,
};

export function getChannelAdapter(
  channel: OmnichannelAdapterChannel,
): ChannelAdapter {
  return CHANNEL_ADAPTER_REGISTRY[channel];
}

/** Read-only snapshot for ops/UI introspection (no credentials). */
export function listChannelAdapterStatuses(): Array<{
  channel: OmnichannelAdapterChannel;
  status: ChannelAdapterConnectionStatus;
  canSend: false;
}> {
  return OMNICHANNEL_ADAPTER_CHANNELS.map((channel) => ({
    channel,
    status: CHANNEL_ADAPTER_REGISTRY[channel].status,
    canSend: false,
  }));
}
