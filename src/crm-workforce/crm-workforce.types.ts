/**
 * AMQUR CRM Workforce — shared vocabulary. See docs/CRM_WORKFORCE.md.
 *
 * The workforce is additive: it is gated by the `crmWorkforce` feature flag (default off) AND the
 * CRM_WORKFORCE_ENABLED process switch (default off). Customer-facing sending additionally needs
 * CRM_WORKFORCE_EXTERNAL_SEND_ENABLED plus an explicit per-scope control row.
 */
export const CRM_WORKFORCE_FLAG = 'crmWorkforce';

export type Department = 'SALES' | 'SERVICE' | 'PARTS';
export const DEPARTMENTS: readonly Department[] = ['SALES', 'SERVICE', 'PARTS'];

export type OperatingMode =
  | 'OBSERVE'
  | 'ASSIST'
  | 'SUPERVISED'
  | 'CONTROLLED_AUTONOMOUS';

/** Least → most autonomous. A scope can only narrow what its parent allows. */
export const MODE_RANK: Record<OperatingMode, number> = {
  OBSERVE: 0,
  ASSIST: 1,
  SUPERVISED: 2,
  CONTROLLED_AUTONOMOUS: 3,
};

export type Channel = 'SMS' | 'EMAIL';
export type MessagePurpose = 'TRANSACTIONAL' | 'CONVERSATIONAL' | 'MARKETING';

export type AgentKey =
  | 'sales_bdc'
  | 'service_bdc'
  | 'parts_bdc'
  | 'lead_recovery'
  | 'conversation_manager'
  | 'appointment_manager';

export type WorkflowKey =
  | 'reply_inbound'
  | 'first_response'
  | 'appointment_change'
  | 'purchase_intent'
  | 'missed_appointment'
  | 'visited_unsold'
  | 'engaged_followup'
  | 'overdue_followup'
  | 'recovery_reactivation';

/** Whether a workflow is the customer waiting on us (inbound) or us starting contact (outbound). */
export const WORKFLOW_DIRECTION: Record<
  WorkflowKey,
  'INBOUND_REPLY' | 'OUTBOUND'
> = {
  reply_inbound: 'INBOUND_REPLY',
  first_response: 'OUTBOUND',
  appointment_change: 'INBOUND_REPLY',
  purchase_intent: 'INBOUND_REPLY',
  missed_appointment: 'OUTBOUND',
  visited_unsold: 'OUTBOUND',
  engaged_followup: 'OUTBOUND',
  overdue_followup: 'OUTBOUND',
  recovery_reactivation: 'OUTBOUND',
};

export const WORKFLOW_PURPOSE: Record<WorkflowKey, MessagePurpose> = {
  reply_inbound: 'CONVERSATIONAL',
  first_response: 'CONVERSATIONAL',
  appointment_change: 'TRANSACTIONAL',
  purchase_intent: 'CONVERSATIONAL',
  missed_appointment: 'CONVERSATIONAL',
  visited_unsold: 'CONVERSATIONAL',
  engaged_followup: 'CONVERSATIONAL',
  overdue_followup: 'CONVERSATIONAL',
  recovery_reactivation: 'MARKETING',
};

/** Provenance every dealership fact carries (CLAUDE.md). */
export type Provenance = {
  sourceRecordId: string;
  asOf: string;
  verified: boolean;
  rooftopId: string;
};

export type VerifiedFact = Provenance & {
  kind: 'hours' | 'inventory' | 'offer' | 'appointment' | 'policy' | 'contact';
  text: string;
};

export function envOn(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (env[name] ?? '').trim().toLowerCase() === 'true';
}
