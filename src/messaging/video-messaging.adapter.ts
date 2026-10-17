import type {
  ChannelAdapter,
  ChannelSendParams,
  ChannelSendResult,
} from './channel-adapters';

/** Live video / WebRTC messaging — not wired; outbound is always suppressed. */
export const VIDEO_MESSAGING_CHANNEL = 'VIDEO' as const;

export type VideoMessagingChannel = typeof VIDEO_MESSAGING_CHANNEL;

export const videoMessagingAdapter: ChannelAdapter = {
  channel: VIDEO_MESSAGING_CHANNEL,
  status: 'not_connected',
  async send(_params: ChannelSendParams): Promise<ChannelSendResult> {
    return { status: 'SUPPRESSED', reason: 'provider_not_configured' };
  },
};
