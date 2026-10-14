/**
 * Versioned, deterministic lead scoring. Score is a function of the SET of journey signals
 * (repeating a message cannot inflate it). Every signal has a weight — no orphaned events.
 * Score never triggers customer communication on its own; it informs staff prioritization.
 */
export const LEAD_SCORE_VERSION = 'journey-v3-2026-10';

export type LeadSignal =
  | 'inventory_search'
  | 'vehicle_selected'
  | 'vehicle_compare'
  | 'feature_question'
  | 'payment_estimate'
  | 'budget_stated'
  | 'trade_provided'
  | 'finance_interest'
  | 'credit_link_offered'
  | 'credit_link_clicked'
  | 'appointment_requested'
  | 'test_drive_requested'
  | 'contact_name'
  | 'contact_method'
  | 'text_consent'
  | 'handoff_requested'
  | 'hold_requested'
  | 'timeline_soon'
  | 'service_request'
  | 'parts_request'
  | 'saved_vehicle'
  | 'quote_requested'
  | 'return_visit';

export const SIGNAL_WEIGHTS: Record<LeadSignal, number> = {
  inventory_search: 1,
  vehicle_selected: 3,
  vehicle_compare: 2,
  feature_question: 1,
  payment_estimate: 3,
  budget_stated: 2,
  trade_provided: 4,
  finance_interest: 3,
  credit_link_offered: 2,
  credit_link_clicked: 5,
  appointment_requested: 8,
  test_drive_requested: 8,
  contact_name: 2,
  contact_method: 5,
  text_consent: 2,
  handoff_requested: 6,
  hold_requested: 6,
  timeline_soon: 4,
  service_request: 3,
  parts_request: 2,
  saved_vehicle: 2,
  quote_requested: 4,
  return_visit: 2,
};

export type LeadScore = {
  score: number;
  stage: 'cold' | 'warm' | 'hot';
  reasons: Array<{ signal: LeadSignal; weight: number }>;
  version: string;
  nextBestAction: string;
};

export function scoreJourney(
  signals: Iterable<LeadSignal>,
  ctx: {
    hasAppointment?: boolean;
    hasContact?: boolean;
    hasVehicle?: boolean;
    handoffOpen?: boolean;
  } = {},
): LeadScore {
  const set = new Set(signals);
  const reasons = [...set]
    .filter((s) => s in SIGNAL_WEIGHTS)
    .map((signal) => ({ signal, weight: SIGNAL_WEIGHTS[signal] }))
    .sort((a, b) => b.weight - a.weight);
  const score = Math.min(
    100,
    reasons.reduce((a, r) => a + r.weight, 0),
  );
  const stage = score >= 18 ? 'hot' : score >= 8 ? 'warm' : 'cold';
  let nextBestAction = 'Engage: answer questions and show matching inventory';
  if (ctx.handoffOpen) nextBestAction = 'Respond to open handoff request';
  else if (ctx.hasAppointment && ctx.hasContact)
    nextBestAction = 'Confirm requested appointment time with customer';
  else if (ctx.hasAppointment)
    nextBestAction = 'Obtain contact details to confirm appointment';
  else if (set.has('credit_link_clicked'))
    nextBestAction = 'Follow up on credit application in DMS/CRM';
  else if (set.has('trade_provided') && ctx.hasContact)
    nextBestAction = 'Prepare trade appraisal and call customer';
  else if (ctx.hasVehicle && ctx.hasContact)
    nextBestAction = 'Verify availability and invite for test drive';
  else if (ctx.hasVehicle)
    nextBestAction = 'Offer test drive or payment walkthrough';
  return { score, stage, reasons, version: LEAD_SCORE_VERSION, nextBestAction };
}
