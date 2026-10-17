/** Voice readiness contracts — no fragile live voice implementation. */
export type VoiceCallState =
  | 'RINGING'
  | 'ANSWERED'
  | 'IN_PROGRESS'
  | 'ON_HOLD'
  | 'TRANSFERRING'
  | 'COMPLETED'
  | 'FAILED'
  | 'VOICEMAIL';

export type VoiceSession = {
  tenantId: string;
  locationId?: string | null;
  externalCallId: string;
  state: VoiceCallState;
  direction: 'INBOUND' | 'OUTBOUND';
  from?: string | null;
  to?: string | null;
  recordingConsent: boolean;
  language?: string | null;
  conversationExternalKey?: string | null;
};

export type VoiceActionSuppressedReason = 'not_configured' | 'disabled';

export type VoiceCallActionResult =
  | { status: 'SUPPRESSED'; reason: VoiceActionSuppressedReason }
  | { status: 'OK' };

export function voiceSuppressed(
  reason: VoiceActionSuppressedReason,
): VoiceCallActionResult {
  return { status: 'SUPPRESSED', reason };
}

export interface VoiceProvider {
  readonly providerId: string;
  isLiveConfigured(): boolean;
  answer(session: VoiceSession): Promise<VoiceCallActionResult>;
  placeOutbound(session: VoiceSession): Promise<VoiceCallActionResult>;
  transferToStaff(
    session: VoiceSession,
    reason: string,
  ): Promise<VoiceCallActionResult>;
  hangup(session: VoiceSession): Promise<VoiceCallActionResult>;
}

/** Stub — live voice requires approved provider + consent + retention policy. */
export class DisabledVoiceProvider implements VoiceProvider {
  readonly providerId = 'disabled';
  isLiveConfigured(): boolean {
    return false;
  }
  async answer(_session: VoiceSession): Promise<VoiceCallActionResult> {
    return voiceSuppressed('not_configured');
  }
  async placeOutbound(_session: VoiceSession): Promise<VoiceCallActionResult> {
    return voiceSuppressed('not_configured');
  }
  async transferToStaff(
    _session: VoiceSession,
    _reason: string,
  ): Promise<VoiceCallActionResult> {
    return voiceSuppressed('not_configured');
  }
  async hangup(_session: VoiceSession): Promise<VoiceCallActionResult> {
    return voiceSuppressed('not_configured');
  }
}
