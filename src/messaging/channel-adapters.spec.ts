import {
  CHANNEL_ADAPTER_REGISTRY,
  OMNICHANNEL_ADAPTER_CHANNELS,
  getChannelAdapter,
  listChannelAdapterStatuses,
} from './channel-adapters';

describe('channel adapters (not_connected)', () => {
  it('registers WhatsApp, Messenger, Instagram, and email', () => {
    expect(Object.keys(CHANNEL_ADAPTER_REGISTRY).sort()).toEqual(
      [...OMNICHANNEL_ADAPTER_CHANNELS].sort(),
    );
  });

  it('lists honest not_connected status for every channel', () => {
    const rows = listChannelAdapterStatuses();
    expect(rows).toHaveLength(OMNICHANNEL_ADAPTER_CHANNELS.length);
    for (const row of rows) {
      expect(row.status).toBe('not_connected');
      expect(row.canSend).toBe(false);
    }
  });

  it.each(OMNICHANNEL_ADAPTER_CHANNELS)(
    '%s send is suppressed with provider_not_configured',
    async (channel) => {
      const adapter = getChannelAdapter(channel);
      expect(adapter.status).toBe('not_connected');
      expect(adapter.channel).toBe(channel);

      const result = await adapter.send({
        tenantId: 'tenant-1',
        locationId: 'loc-1',
        to: channel === 'EMAIL' ? 'buyer@example.com' : '+15551234567',
        body: 'Hello from AMQUR',
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
    },
  );
});
