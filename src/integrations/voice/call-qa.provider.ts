/**
 * Call QA / coaching contracts — no invented transcripts, scores, or tips.
 */
export type CallQaBlockedReason = 'voice_not_live' | 'insufficient_input';

export type CallQaBlocked = {
  status: 'blocked';
  reason: CallQaBlockedReason;
};

export function callQaBlocked(reason: CallQaBlockedReason): CallQaBlocked {
  return { status: 'blocked', reason };
}

export type CallQaScope = {
  tenantId: string;
  locationId?: string | null;
};

export type SummarizeCallParams = CallQaScope & {
  externalCallId: string;
  /** Verified transcript text — never synthesized from call metadata alone. */
  transcript?: string | null;
};

export type SummarizeCallResult =
  | CallQaBlocked
  | { status: 'ok'; externalCallId: string; summary: string };

export type ScoreCallParams = CallQaScope & {
  externalCallId: string;
  transcript?: string | null;
};

export type ScoreCallResult =
  | CallQaBlocked
  | {
      status: 'ok';
      externalCallId: string;
      score: number;
      dimensions: Record<string, number>;
    };

export type ListCoachingTipsParams = CallQaScope & {
  externalCallId?: string | null;
};

export type CoachingTip = {
  id: string;
  title: string;
  detail: string;
};

export type ListCoachingTipsResult =
  | CallQaBlocked
  | { status: 'ok'; tips: CoachingTip[] };

export interface CallQaProvider {
  readonly providerId: string;
  isLiveConfigured(): boolean;
  summarizeCall(params: SummarizeCallParams): Promise<SummarizeCallResult>;
  scoreCall(params: ScoreCallParams): Promise<ScoreCallResult>;
  listCoachingTips(
    params: ListCoachingTipsParams,
  ): Promise<ListCoachingTipsResult>;
}

/** Stub until live voice transcription + QA vendor is authorized. */
export class DisabledCallQaProvider implements CallQaProvider {
  readonly providerId = 'disabled';

  isLiveConfigured(): boolean {
    return false;
  }

  async summarizeCall(_params: SummarizeCallParams): Promise<SummarizeCallResult> {
    return callQaBlocked('voice_not_live');
  }

  async scoreCall(_params: ScoreCallParams): Promise<ScoreCallResult> {
    return callQaBlocked('voice_not_live');
  }

  async listCoachingTips(
    _params: ListCoachingTipsParams,
  ): Promise<ListCoachingTipsResult> {
    return callQaBlocked('voice_not_live');
  }
}
