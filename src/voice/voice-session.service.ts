import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { DisabledVoiceProvider } from '../integrations/voice/voice.provider';
import type {
  VoiceCallActionResult,
  VoiceSession,
} from '../integrations/voice/voice.provider';
import { voiceSuppressed } from '../integrations/voice/voice.provider';

export type VoiceLiveGate =
  | { allowed: true }
  | { allowed: false; reason: 'disabled' | 'not_configured' };

@Injectable()
export class VoiceSessionService {
  private readonly provider = new DisabledVoiceProvider();

  constructor(
    private readonly prisma: PrismaService,
    private readonly featureFlags: FeatureFlagsService,
  ) {}

  getProvider() {
    return this.provider;
  }

  /** Fail-closed: reserved `voiceAi` + live-ready TWILIO voice connection + live provider. */
  async resolveLiveVoiceGate(
    tenantId: string,
    locationId?: string | null,
  ): Promise<VoiceLiveGate> {
    const flags = await this.featureFlags.resolve(tenantId, locationId);
    if (flags.voiceAi !== true) {
      return { allowed: false, reason: 'disabled' };
    }

    const conn = await this.prisma.integrationConnection.findFirst({
      where: {
        tenantId,
        provider: 'TWILIO',
        capability: 'voice',
        enabled: true,
        liveReady: true,
        OR: locationId
          ? [{ locationId }, { locationId: null }]
          : [{ locationId: null }],
      },
      select: { id: true },
    });
    if (!conn || !this.provider.isLiveConfigured()) {
      return { allowed: false, reason: 'not_configured' };
    }
    return { allowed: true };
  }

  private async gateLiveAction(
    session: VoiceSession,
  ): Promise<VoiceCallActionResult | null> {
    const gate = await this.resolveLiveVoiceGate(
      session.tenantId,
      session.locationId,
    );
    if (!gate.allowed) {
      return voiceSuppressed(gate.reason);
    }
    return null;
  }

  async upsertSession(params: {
    tenantId: string;
    locationId?: string | null;
    externalCallId: string;
    direction: string;
    state: string;
    fromNumber?: string | null;
    toNumber?: string | null;
    recordingConsent?: boolean;
    language?: string | null;
    conversationExternalKey?: string | null;
    metadata?: Record<string, unknown>;
  }) {
    return this.prisma.voiceCallSession.upsert({
      where: {
        tenantId_externalCallId: {
          tenantId: params.tenantId,
          externalCallId: params.externalCallId,
        },
      },
      create: {
        tenantId: params.tenantId,
        locationId: params.locationId ?? null,
        externalCallId: params.externalCallId,
        direction: params.direction,
        state: params.state,
        fromNumber: params.fromNumber ?? null,
        toNumber: params.toNumber ?? null,
        recordingConsent: params.recordingConsent ?? false,
        language: params.language ?? null,
        conversationExternalKey: params.conversationExternalKey ?? null,
        metadata: (params.metadata ?? {}) as Prisma.InputJsonValue,
      },
      update: {
        state: params.state,
        fromNumber: params.fromNumber ?? null,
        toNumber: params.toNumber ?? null,
        recordingConsent: params.recordingConsent ?? false,
        language: params.language ?? null,
        conversationExternalKey: params.conversationExternalKey ?? null,
        metadata: (params.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  /** Persists end state only — summary must come from verified transcription, never invented. */
  async endSession(tenantId: string, externalCallId: string, summary?: string) {
    return this.prisma.voiceCallSession.update({
      where: {
        tenantId_externalCallId: { tenantId, externalCallId },
      },
      data: {
        state: 'COMPLETED',
        endedAt: new Date(),
        summary: summary ?? null,
      },
    });
  }

  async handleInbound(session: VoiceSession): Promise<VoiceCallActionResult> {
    const blocked = await this.gateLiveAction(session);
    if (blocked) return blocked;
    return this.provider.answer(session);
  }

  async placeOutbound(session: VoiceSession): Promise<VoiceCallActionResult> {
    const blocked = await this.gateLiveAction(session);
    if (blocked) return blocked;
    return this.provider.placeOutbound(session);
  }

  async transferToStaff(
    session: VoiceSession,
    reason: string,
  ): Promise<VoiceCallActionResult> {
    const blocked = await this.gateLiveAction(session);
    if (blocked) return blocked;
    return this.provider.transferToStaff(session, reason);
  }

  async hangup(session: VoiceSession): Promise<VoiceCallActionResult> {
    const blocked = await this.gateLiveAction(session);
    if (blocked) return blocked;
    return this.provider.hangup(session);
  }
}
