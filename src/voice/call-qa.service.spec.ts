import { CallQaService } from './call-qa.service';
import type { VoiceSessionService } from './voice-session.service';

describe('CallQaService (fail-closed)', () => {
  const prisma = {
    voiceCallSession: { findUnique: jest.fn() },
  };
  const voiceSessions = {
    resolveLiveVoiceGate: jest.fn(),
  };
  const svc = new CallQaService(
    prisma as never,
    voiceSessions as unknown as VoiceSessionService,
  );

  beforeEach(() => {
    jest.resetAllMocks();
    voiceSessions.resolveLiveVoiceGate.mockResolvedValue({
      allowed: false,
      reason: 'disabled',
    });
    prisma.voiceCallSession.findUnique.mockResolvedValue(null);
  });

  it('summarizeCall returns voice_not_live when voice is not live', async () => {
    const result = await svc.summarizeCall({
      tenantId: 'tenant-1',
      locationId: 'loc-1',
      externalCallId: 'call-1',
      transcript: 'Hello, I need an oil change.',
    });

    expect(result).toEqual({ status: 'blocked', reason: 'voice_not_live' });
    expect(prisma.voiceCallSession.findUnique).not.toHaveBeenCalled();
  });

  it('scoreCall returns voice_not_live when voice is not live', async () => {
    const result = await svc.scoreCall({
      tenantId: 'tenant-1',
      externalCallId: 'call-1',
      transcript: 'Staff greeted the caller promptly.',
    });

    expect(result).toEqual({ status: 'blocked', reason: 'voice_not_live' });
  });

  it('listCoachingTips returns voice_not_live when voice is not live', async () => {
    const result = await svc.listCoachingTips({
      tenantId: 'tenant-1',
      locationId: 'loc-1',
    });

    expect(result).toEqual({ status: 'blocked', reason: 'voice_not_live' });
  });

  it('does not invent summary from empty transcript when gate would allow', async () => {
    voiceSessions.resolveLiveVoiceGate.mockResolvedValue({ allowed: true });

    const result = await svc.summarizeCall({
      tenantId: 'tenant-1',
      externalCallId: 'call-1',
      transcript: '   ',
    });

    expect(result).toEqual({ status: 'blocked', reason: 'insufficient_input' });
  });

  it('does not invent scores when no transcript is available', async () => {
    voiceSessions.resolveLiveVoiceGate.mockResolvedValue({ allowed: true });

    const result = await svc.scoreCall({
      tenantId: 'tenant-1',
      externalCallId: 'call-1',
    });

    expect(result).toEqual({ status: 'blocked', reason: 'insufficient_input' });
    expect(prisma.voiceCallSession.findUnique).toHaveBeenCalledWith({
      where: {
        tenantId_externalCallId: {
          tenantId: 'tenant-1',
          externalCallId: 'call-1',
        },
      },
      select: { metadata: true },
    });
  });

  it('returns voice_not_live when flag and connection pass but QA provider is disabled', async () => {
    voiceSessions.resolveLiveVoiceGate.mockResolvedValue({ allowed: true });

    const result = await svc.listCoachingTips({
      tenantId: 'tenant-1',
    });

    expect(result).toEqual({ status: 'blocked', reason: 'voice_not_live' });
  });
});
