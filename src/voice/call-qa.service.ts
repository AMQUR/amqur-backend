import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  DisabledCallQaProvider,
  callQaBlocked,
  type ListCoachingTipsParams,
  type ListCoachingTipsResult,
  type ScoreCallParams,
  type ScoreCallResult,
  type SummarizeCallParams,
  type SummarizeCallResult,
} from '../integrations/voice/call-qa.provider';
import { VoiceSessionService } from './voice-session.service';

/**
 * Fail-closed call QA: summarize, score, and coaching tips only when
 * `voiceAi` is on and a live-ready voice connection exists — never today.
 */
@Injectable()
export class CallQaService {
  private readonly provider = new DisabledCallQaProvider();

  constructor(
    private readonly prisma: PrismaService,
    private readonly voiceSessions: VoiceSessionService,
  ) {}

  async summarizeCall(
    params: SummarizeCallParams,
  ): Promise<SummarizeCallResult> {
    const blocked = await this.gateOrInputBlocked(params);
    if (blocked) return blocked;
    return this.provider.summarizeCall(params);
  }

  async scoreCall(params: ScoreCallParams): Promise<ScoreCallResult> {
    const blocked = await this.gateOrInputBlocked(params);
    if (blocked) return blocked;
    return this.provider.scoreCall(params);
  }

  async listCoachingTips(
    params: ListCoachingTipsParams,
  ): Promise<ListCoachingTipsResult> {
    const blocked = await this.gateBlocked(params.tenantId, params.locationId);
    if (blocked) return blocked;
    return this.provider.listCoachingTips(params);
  }

  private async voiceLiveBlocked(
    tenantId: string,
    locationId?: string | null,
  ): Promise<ReturnType<typeof callQaBlocked> | null> {
    const gate = await this.voiceSessions.resolveLiveVoiceGate(
      tenantId,
      locationId,
    );
    if (!gate.allowed) {
      return callQaBlocked('voice_not_live');
    }
    return null;
  }

  private qaProviderBlocked(): ReturnType<typeof callQaBlocked> | null {
    if (!this.provider.isLiveConfigured()) {
      return callQaBlocked('voice_not_live');
    }
    return null;
  }

  private async gateBlocked(
    tenantId: string,
    locationId?: string | null,
  ): Promise<ReturnType<typeof callQaBlocked> | null> {
    const voiceBlocked = await this.voiceLiveBlocked(tenantId, locationId);
    if (voiceBlocked) return voiceBlocked;
    return this.qaProviderBlocked();
  }

  private async gateOrInputBlocked(
    params: SummarizeCallParams | ScoreCallParams,
  ): Promise<ReturnType<typeof callQaBlocked> | null> {
    const voiceBlocked = await this.voiceLiveBlocked(
      params.tenantId,
      params.locationId,
    );
    if (voiceBlocked) return voiceBlocked;

    const callId = params.externalCallId?.trim();
    if (!callId) {
      return callQaBlocked('insufficient_input');
    }

    const transcript = await this.resolveVerifiedTranscript(
      params.tenantId,
      callId,
      params.transcript,
    );
    if (!transcript?.trim()) {
      return callQaBlocked('insufficient_input');
    }

    return this.qaProviderBlocked();
  }

  /** Transcript must be supplied or stored on the session — never fabricated. */
  private async resolveVerifiedTranscript(
    tenantId: string,
    externalCallId: string,
    explicit?: string | null,
  ): Promise<string | null> {
    const fromRequest = explicit?.trim();
    if (fromRequest) return fromRequest;

    const session = await this.prisma.voiceCallSession.findUnique({
      where: {
        tenantId_externalCallId: { tenantId, externalCallId },
      },
      select: { metadata: true },
    });
    if (!session?.metadata || typeof session.metadata !== 'object') {
      return null;
    }
    const meta = session.metadata as Record<string, unknown>;
    const stored = meta.transcript;
    return typeof stored === 'string' && stored.trim() ? stored.trim() : null;
  }
}
