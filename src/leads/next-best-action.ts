export function nextBestAction(lead: {
  score: number;
  interestedVin?: string | null;
  email?: string | null;
  phone?: string | null;
  financingNeeded?: boolean | null;
  stage: string;
}): string {
  if (!lead.email && !lead.phone) return 'request_contact_info';
  if (lead.interestedVin && lead.score >= 6) return 'confirm_availability';
  if (lead.financingNeeded) return 'offer_payment_estimate';
  if (lead.score >= 12) return 'schedule_test_drive';
  if (lead.interestedVin) return 'ask_trade_or_timeline';
  return 'continue_discovery';
}
