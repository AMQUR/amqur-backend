export type LeadStage = 'cold' | 'warm' | 'hot';

export type LeadScoreResult = {
  score: number;
  reasons: string[];
  version: string;
};

const SCORE_VERSION = 'rules-v2';

export function scoreLeadEvent(
    currentScore: number,
    event: string,
): number {
    const weights: Record<string, number> = {
        inventory_search: 1,
        vehicle_view: 2,
        compare: 2,
        pricing: 2,
        payment: 3,
        appointment: 5,
        hold: 6,
        human: 10,
        trade: 3,
        financing: 3,
        test_drive: 5,
        contact_captured: 4,
        service_urgency: 6,
    };

    return currentScore + (weights[event] ?? 0);
}

export function scoreLeadWithReasons(
  currentScore: number,
  events: string[],
): LeadScoreResult {
  const reasons: string[] = [];
  let score = currentScore;
  for (const event of events) {
    const before = score;
    score = scoreLeadEvent(score, event);
    if (score > before) reasons.push(event);
  }
  return { score, reasons, version: SCORE_VERSION };
}

export function stageFromScore(score: number): LeadStage {
    if (score >= 12) return 'hot';
    if (score >= 6) return 'warm';
    return 'cold';
}
