import { VoiceSessionService } from './voice-session.service';
import type { VoiceSession } from '../integrations/voice/voice.provider';
import { DisabledVoiceProvider } from '../integrations/voice/voice.provider';

const baseSession: VoiceSession = {
  tenantId: 'tenant-1',
  locationId: 'loc-1',
  externalCallId: 'call-1',
  state: 'RINGING',
  direction: 'INBOUND',
  recordingConsent: false,
};

describe('VoiceSessionService (fail-closed)', () => {
  const prisma = {
    integrationConnection: { findFirst: jest.fn() },
    voiceCallSession: { upsert: jest.fn(), update: jest.fn() },
  };
  const featureFlags = { resolve: jest.fn() };
  const svc = new VoiceSessionService(prisma as never, featureFlags as never);

  beforeEach(() => {
    jest.resetAllMocks();
    featureFlags.resolve.mockResolvedValue({ voiceAi: false });
    prisma.integrationConnection.findFirst.mockResolvedValue(null);
  });

  it('blocks inbound answer when voiceAi is off', async () => {
    const result = await svc.handleInbound(baseSession);
    expect(result).toEqual({ status: 'SUPPRESSED', reason: 'disabled' });
    expect(prisma.integrationConnection.findFirst).not.toHaveBeenCalled();
  });

  it('blocks outbound place when voiceAi is off', async () => {
    const result = await svc.placeOutbound({
      ...baseSession,
      direction: 'OUTBOUND',
    });
    expect(result).toEqual({ status: 'SUPPRESSED', reason: 'disabled' });
  });

  it('returns not_configured when voiceAi on but no live-ready voice connection', async () => {
    featureFlags.resolve.mockResolvedValue({ voiceAi: true });
    prisma.integrationConnection.findFirst.mockResolvedValue(null);

    const result = await svc.handleInbound(baseSession);
    expect(result).toEqual({ status: 'SUPPRESSED', reason: 'not_configured' });
    expect(prisma.integrationConnection.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          provider: 'TWILIO',
          capability: 'voice',
          liveReady: true,
        }),
      }),
    );
  });

  it('DisabledVoiceProvider never reports live configured', () => {
    const p = new DisabledVoiceProvider();
    expect(p.isLiveConfigured()).toBe(false);
  });
});
