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

export interface VoiceProvider {
  readonly providerId: string;
  isLiveConfigured(): boolean;
  answer(session: VoiceSession): Promise<{ ok: boolean }>;
  transferToStaff(
    session: VoiceSession,
    reason: string,
  ): Promise<{ ok: boolean }>;
  hangup(session: VoiceSession): Promise<{ ok: boolean }>;
}

/** Stub — live voice requires approved provider + consent + retention policy. */
export class DisabledVoiceProvider implements VoiceProvider {
  readonly providerId = 'disabled';
  isLiveConfigured(): boolean {
    return false;
  }
  async answer(): Promise<{ ok: boolean }> {
    return { ok: false };
  }
  async transferToStaff(): Promise<{ ok: boolean }> {
    return { ok: false };
  }
  async hangup(): Promise<{ ok: boolean }> {
    return { ok: false };
  }
}
