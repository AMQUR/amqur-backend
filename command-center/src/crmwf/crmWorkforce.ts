/**
 * CRM Workforce — pure view logic for the Command Center (no React, unit-tested).
 * Wording rule for this whole surface: a status is shown as exactly what it is. "Sent" is only
 * ever used for VERIFIED (read back from the CRM) — never for approved, queued, accepted or
 * uncertain — and data that came from the synthetic fixture adapter is labelled DEMO.
 */
export const BASE = '/ops/crm-workforce';
export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral';

export type Mode = 'OBSERVE' | 'ASSIST' | 'SUPERVISED' | 'CONTROLLED_AUTONOMOUS';
export const MODES: Array<{ id: Mode; label: string; what: string }> = [
  { id: 'OBSERVE', label: 'Observe', what: 'Reads and analyses. No drafts, no writes.' },
  { id: 'ASSIST', label: 'Assist', what: 'Writes drafts for employees to send themselves.' },
  { id: 'SUPERVISED', label: 'Supervised', what: 'Sends only what a manager approves.' },
  { id: 'CONTROLLED_AUTONOMOUS', label: 'Controlled autonomous', what: 'Sends pre-authorised routine messages within set limits.' },
];
export const modeLabel = (m: string | null | undefined) => MODES.find((x) => x.id === m)?.label ?? 'Observe';

export const PRIORITIES: Record<number, string> = {
  0: 'P0 · Customer waiting for a reply',
  1: 'P1 · New lead, no response yet',
  2: 'P2 · Appointment change',
  3: 'P3 · Ready to buy',
  4: 'P4 · Missed appointment / visited, not sold',
  5: 'P5 · Engaged, needs follow-up',
  6: 'P6 · Overdue follow-up',
  7: 'P7 · Older lead reactivation',
};
export const priorityLabel = (p: number) => PRIORITIES[p] ?? `P${p}`;

export type Control = { id: string; scope: string; scopeKey: string; tenantId: string | null; locationId: string | null; department: string | null; subjectKey: string | null; halted: boolean; mode: Mode | null; externalSendEnabled: boolean | null; reason: string | null; updatedAt: string };
export type Capability = { operation: string; sideEffect: 'READ_ONLY' | 'DRAFT_ONLY' | 'EXTERNAL'; status: string; reason: string | null };
export type Connection = { id: string; locationId: string; enabled: boolean; status: string; statusReason: string | null; authorizationRef: string | null; authorizedAt: string | null; lastHealthAt: string | null; lastSyncAt: string | null; lastError: string | null };
export type Connector = { adapterKey: string; label: string; requiresAuthorization: boolean; capabilities: Capability[]; connections: Connection[] };
export type Status = { featureFlag: boolean; processEnabled: boolean; externalSendEnv: boolean; emergencyStopEnv: boolean; globalHalted: boolean; controls: Control[]; workers: Array<{ workerId: string; role: string; state: string; lastBeatAt: string; startedAt: string }>; connectors: Connector[] };
export type Overview = { dataLabel: 'NO DATA' | 'DEMO' | 'MIXED' | 'CRM DATA'; leads: { total: number; synthetic: number }; tasks: Array<{ status: string; priority: number; department: string; count: number }>; actions: Array<{ status: string; count: number }>; activeSuppressions: number; pausedLeads: number };
export type LeadLite = { id: string; firstName: string | null; lastName: string | null; leadSource?: string | null; crmStatus?: string | null; assignedTo: string | null; synthetic: boolean; verified?: boolean; asOf?: string; vehicleInterest: { year?: number; make?: string; model?: string } | null };
export type Task = { id: string; crmLeadId: string; department: string; agentKey: string; workflowKey: string; priority: number; status: string; statusReason: string | null; evidence: { segment?: string; rules?: Array<{ rule: string }>; signals?: string[] }; attempts: number; lastError: string | null; createdAt: string; updatedAt: string; lead: LeadLite | null };
export type Block = { rule: string; detail?: string };
export type Action = { id: string; crmLeadId: string | null; locationId: string; department: string | null; actionType: string; sideEffect: string; adapterKey: string | null; channel: string | null; status: string; statusReason: string | null; payload: { body?: string; agent?: string; workflow?: string; identity?: string; facts?: Array<{ kind: string; sourceRecordId: string; asOf: string }> }; complianceDecision: { sendAllowed: boolean; blocks: Block[]; policyVersion: string; purpose: string } | null; playbookKey: string | null; playbookVersion: number | null; createdAt: string; verifiedAt: string | null; lead: LeadLite | null };

/** The overall state banner. Order matters: the most restrictive true statement wins. */
export function workforceState(s: Status): { tone: Tone; label: string; detail: string } {
  if (!s.featureFlag) return { tone: 'neutral', label: 'OFF', detail: 'CRM Workforce is not enabled for this rooftop.' };
  if (s.emergencyStopEnv || s.globalHalted) return { tone: 'bad', label: 'STOPPED', detail: 'Emergency stop is on. No work is being processed anywhere.' };
  if (!s.processEnabled) return { tone: 'warn', label: 'PAUSED', detail: 'The workforce engine is switched off for this deployment. Queued work is waiting; nothing is processed or sent.' };
  const live = s.workers.filter((w) => w.state === 'RUNNING');
  if (!live.length) return { tone: 'bad', label: 'DISCONNECTED', detail: 'No worker has reported in. Queued work is not being processed.' };
  if (s.controls.some((c) => c.halted)) return { tone: 'warn', label: 'PARTLY PAUSED', detail: 'One or more kill switches or pauses are on. See Controls.' };
  if (s.connectors.some((c) => c.connections.some((x) => x.enabled && x.status !== 'READY'))) return { tone: 'warn', label: 'DEGRADED', detail: 'A CRM connection needs attention. See Connections.' };
  return { tone: 'ok', label: 'LIVE', detail: 'The engine is running. Customer sending still depends on each rooftop’s own settings.' };
}

/** Can anything reach a customer from this rooftop right now? Stated plainly. */
export function sendingState(s: Status, locationId: string): { tone: Tone; label: string } {
  const loc = s.controls.find((c) => c.scope === 'LOCATION' && c.locationId === locationId);
  if (!s.externalSendEnv || !loc?.externalSendEnabled) return { tone: 'neutral', label: 'Customer sending: OFF' };
  if (loc.mode === 'OBSERVE' || loc.mode === 'ASSIST' || !loc.mode) return { tone: 'neutral', label: 'Customer sending: OFF (mode does not send)' };
  return { tone: 'warn', label: `Customer sending: ON (${modeLabel(loc.mode)})` };
}

export function capabilityTone(status: string): Tone {
  if (status === 'LIVE VERIFIED' || status === 'SANDBOX VERIFIED') return 'ok';
  if (status === 'DEMO') return 'info';
  if (status === 'BLOCKED') return 'warn';
  return 'neutral';
}

const ACTION_LABEL: Record<string, string> = {
  DRAFT: 'Draft for employee',
  PENDING_APPROVAL: 'Waiting for approval',
  APPROVED: 'Approved, not sent yet',
  REJECTED: 'Rejected',
  QUEUED: 'Queued, not sent yet',
  EXECUTING: 'Sending…',
  SENT_UNVERIFIED: 'Handed to CRM — not confirmed',
  UNCERTAIN: 'Unknown — may or may not have sent',
  VERIFIED: 'Sent (confirmed in CRM)',
  STAFF_CONFIRMED: 'Sent by employee (their statement)',
  BLOCKED: 'Blocked — not sent',
  FAILED: 'Failed — not sent',
  CANCELLED: 'Cancelled — not sent',
};
export const actionLabel = (s: string) => ACTION_LABEL[s] ?? s.replace(/_/g, ' ').toLowerCase();
export function actionTone(s: string): Tone {
  if (s === 'VERIFIED') return 'ok';
  if (s === 'STAFF_CONFIRMED') return 'info';
  if (s === 'UNCERTAIN' || s === 'SENT_UNVERIFIED' || s === 'BLOCKED' || s === 'FAILED') return 'bad';
  if (s === 'PENDING_APPROVAL' || s === 'DRAFT' || s === 'APPROVED' || s === 'QUEUED' || s === 'EXECUTING') return 'warn';
  return 'neutral';
}

const RULE_TEXT: Record<string, string> = {
  halted: 'A kill switch or pause is on',
  suppressed: 'Customer asked not to be contacted',
  opted_out: 'Customer opted out of this channel',
  crm_do_not_contact: 'CRM marks this customer do-not-contact',
  no_consent: 'No consent on record for this channel',
  invalid_endpoint: 'Phone or email is not usable',
  no_endpoint: 'No phone or email for this channel',
  consent_purpose_mismatch: 'Consent on record does not cover marketing',
  consent_stale: 'Consent on record is too old to rely on',
  human_owns_conversation: 'A team member is actively handling this customer',
  lead_paused: 'This lead is paused for the virtual team',
  conflicting_open_action: 'Another message for this customer is still open',
  no_unanswered_inbound: 'The customer is not waiting on a reply',
  frequency_day: 'Daily contact limit reached',
  frequency_week: 'Weekly contact limit reached',
  max_unanswered_attempts: 'Too many unanswered attempts already',
  lead_source_restricted: 'This lead source does not allow automated follow-up',
  outside_contact_window: 'Outside permitted contact hours for the customer',
  timezone_unknown: 'Customer time zone could not be determined',
  sender_identity_not_approved: 'No approved virtual identity for this department',
  channel_capability_not_verified: 'The CRM connection cannot send on this channel',
  policy_not_legally_approved: 'Communication policy has not been approved by counsel',
};
const CONTROL_TEXT: Record<string, string> = {
  process_switch_off: 'Workforce engine is off for this deployment',
  external_send_env_off: 'Customer sending is off for this deployment',
  location_not_configured: 'This rooftop has not been configured',
  mode_observe: 'Rooftop is in Observe mode',
  mode_assist: 'Rooftop is in Assist mode (employees send)',
  workflow_not_authorized: 'This workflow has no written authorisation on record',
};
export function blockText(b: Block): string {
  if (b.rule === 'control') {
    const d = b.detail ?? '';
    if (d.startsWith('send_disabled')) return 'Customer sending is switched off for this rooftop or department';
    return CONTROL_TEXT[d] ?? 'A workforce control does not allow sending';
  }
  return RULE_TEXT[b.rule] ?? b.rule.replace(/_/g, ' ');
}

export function leadName(l: LeadLite | null): string {
  if (!l) return 'Unknown customer';
  return [l.firstName, l.lastName].filter(Boolean).join(' ') || 'Unnamed customer';
}
export function vehicleText(l: LeadLite | null): string {
  const v = l?.vehicleInterest;
  return v ? [v.year, v.make, v.model].filter(Boolean).join(' ') : '';
}

export type QueueId = 'inbound' | 'new' | 'appointments' | 'recovery' | 'handoffs' | 'review' | 'errors';
export const QUEUES: Array<{ id: QueueId; label: string; query: string; empty: string }> = [
  { id: 'inbound', label: 'Unanswered inbound', query: 'status=PENDING,CLAIMED,AWAITING_APPROVAL&priority=0', empty: 'No customer is waiting on a reply.' },
  { id: 'new', label: 'New leads', query: 'status=PENDING,CLAIMED,AWAITING_APPROVAL&priority=1', empty: 'No new leads are waiting for a first response.' },
  { id: 'appointments', label: 'Appointments', query: 'status=PENDING,CLAIMED,AWAITING_APPROVAL&priority=2', empty: 'No appointment changes are waiting.' },
  { id: 'recovery', label: 'Lead recovery', query: 'status=PENDING,CLAIMED,AWAITING_APPROVAL', empty: 'No recovery opportunities are queued.' },
  { id: 'handoffs', label: 'Human handoffs', query: 'status=ESCALATED', empty: 'Nothing is waiting for a person.' },
  { id: 'review', label: 'Consent review', query: 'status=BLOCKED', empty: 'No records are waiting for consent review.' },
  { id: 'errors', label: 'Errors', query: 'status=DEAD,FAILED', empty: 'No failed work.' },
];
/** "Lead recovery" is P4–P7; the API filters one priority at a time, so narrow here. */
export const inQueue = (q: QueueId, t: Task) => (q === 'recovery' ? t.priority >= 4 : true);

export function countTasks(o: Overview | null, pred: (t: Overview['tasks'][number]) => boolean): number {
  return (o?.tasks ?? []).filter(pred).reduce((n, t) => n + t.count, 0);
}
export const OPEN_TASK = ['PENDING', 'CLAIMED', 'AWAITING_APPROVAL'];

export function usd(micro: number | null | undefined): string {
  if (micro === null || micro === undefined) return 'No data yet';
  const d = micro / 1_000_000;
  return d < 0.01 && d > 0 ? `$${d.toFixed(4)}` : `$${d.toFixed(2)}`;
}
export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return 'No data yet';
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}
