/**
 * Single source of truth for next-best-action codes + human labels.
 * Copilot and journey scoring both consume these — never invent parallel rules.
 */

export type NbaCode =
  | 'request_contact_info'
  | 'confirm_availability'
  | 'offer_payment_estimate'
  | 'schedule_test_drive'
  | 'ask_trade_or_timeline'
  | 'confirm_appointment'
  | 'obtain_contact_for_appointment'
  | 'follow_up_credit_app'
  | 'prepare_trade_appraisal'
  | 'verify_availability_invite_drive'
  | 'offer_test_drive_or_payment'
  | 'respond_handoff'
  | 'continue_discovery';

const LABELS: Record<NbaCode, string> = {
  request_contact_info: 'Request contact info',
  confirm_availability: 'Confirm vehicle availability',
  offer_payment_estimate: 'Offer payment estimate (illustrative)',
  schedule_test_drive: 'Schedule a test drive',
  ask_trade_or_timeline: 'Ask about trade-in or timeline',
  confirm_appointment: 'Confirm requested appointment time with customer',
  obtain_contact_for_appointment:
    'Obtain contact details to confirm appointment',
  follow_up_credit_app: 'Follow up on credit application in DMS/CRM',
  prepare_trade_appraisal: 'Prepare trade appraisal and call customer',
  verify_availability_invite_drive:
    'Verify availability and invite for test drive',
  offer_test_drive_or_payment: 'Offer test drive or payment walkthrough',
  respond_handoff: 'Respond to open handoff request',
  continue_discovery: 'Engage: answer questions and show matching inventory',
};

export function labelForNba(code: NbaCode): string {
  return LABELS[code] ?? LABELS.continue_discovery;
}

/** Rule helper used by Copilot (code form). */
export function nextBestAction(lead: {
  score: number;
  interestedVin?: string | null;
  email?: string | null;
  phone?: string | null;
  financingNeeded?: boolean | null;
  stage: string;
}): NbaCode {
  if (!lead.email && !lead.phone) return 'request_contact_info';
  if (lead.interestedVin && lead.score >= 6) return 'confirm_availability';
  if (lead.financingNeeded) return 'offer_payment_estimate';
  if (lead.score >= 12) return 'schedule_test_drive';
  if (lead.interestedVin) return 'ask_trade_or_timeline';
  return 'continue_discovery';
}

/** Journey-context NBA used when scoring conversations (human label persisted). */
export function journeyNextBestAction(ctx: {
  handoffOpen?: boolean;
  hasAppointment?: boolean;
  hasContact?: boolean;
  hasVehicle?: boolean;
  signals?: Iterable<string>;
}): string {
  const set = new Set(ctx.signals ?? []);
  let code: NbaCode = 'continue_discovery';
  if (ctx.handoffOpen) code = 'respond_handoff';
  else if (ctx.hasAppointment && ctx.hasContact) code = 'confirm_appointment';
  else if (ctx.hasAppointment) code = 'obtain_contact_for_appointment';
  else if (set.has('credit_link_clicked')) code = 'follow_up_credit_app';
  else if (set.has('trade_provided') && ctx.hasContact)
    code = 'prepare_trade_appraisal';
  else if (ctx.hasVehicle && ctx.hasContact)
    code = 'verify_availability_invite_drive';
  else if (ctx.hasVehicle) code = 'offer_test_drive_or_payment';
  return labelForNba(code);
}
