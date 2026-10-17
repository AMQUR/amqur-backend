import { getChannelAdapter } from './channel-adapters';
import {
  VIDEO_MESSAGING_CHANNEL,
  videoMessagingAdapter,
} from './video-messaging.adapter';

describe('videoMessagingAdapter (not_connected)', () => {
  it('exposes VIDEO channel with not_connected status', () => {
    expect(videoMessagingAdapter.channel).toBe(VIDEO_MESSAGING_CHANNEL);
    expect(videoMessagingAdapter.status).toBe('not_connected');
  });

  it('send is suppressed and never reports delivery', async () => {
    const result = await videoMessagingAdapter.send({
      tenantId: 'tenant-1',
      locationId: 'loc-1',
      to: 'room-abc',
      body: 'Join video session',
      conversationId: 'conv-1',
    });

    expect(result).toEqual({
      status: 'SUPPRESSED',
      reason: 'provider_not_configured',
    });
    expect(result).not.toHaveProperty('id');
    expect(result).not.toMatchObject({ status: 'QUEUED' });
    expect(result).not.toMatchObject({ status: 'SENT' });
    expect(result).not.toMatchObject({ status: 'DELIVERED' });
  });

  it('is registered in the channel adapter registry', () => {
    expect(getChannelAdapter('VIDEO')).toBe(videoMessagingAdapter);
  });
});
