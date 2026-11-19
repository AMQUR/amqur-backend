/**
 * Lead delivery ledger helpers (pure; unit-tested).
 *
 * The whole point of this screen is that the states are NOT interchangeable: "accepted by the
 * mail transport" is not "delivered", and neither is "in the CRM". Each state says what evidence
 * it rests on, and anything short of CRM_MATCHED is never described as a lead in the CRM.
 */
export type LeadDeliveryStatus =
  | 'QUEUED' | 'SENT' | 'ACCEPTED' | 'DELIVERED' | 'CRM_PARSED' | 'CRM_MATCHED'
  | 'CRM_REJECTED' | 'FAILED' | 'DEAD' | 'BLOCKED';

export type LeadDeliveryRow = {
  id: string;
  locationId: string | null;
  leadId: string;
  channel: string;
  department: string;
  destinationMasked: string | null;
  status: LeadDeliveryStatus;
  attempts: number;
  replayCount: number;
  providerName: string | null;
  /** How the hand-off was made: 'sandbox' never reached a store. Null until a hand-off happens. */
  deliveryMode?: 'sandbox' | 'live' | null;
  providerMessageId: string | null;
  crmRecordRef: string | null;
  blockedReason: string | null;
  lastErrorCode: string | null;
  queuedAt: string | null;
  sentAt: string | null;
  acceptedAt: string | null;
  deliveredAt: string | null;
  crmParsedAt: string | null;
  crmMatchedAt: string | null;
  crmRejectedAt: string | null;
  failedAt: string | null;
  deadAt: string | null;
  blockedAt: string | null;
  correlationId: string | null;
  createdAt: string;
};

export type LeadDeliveryEvent = { id: string; fromStatus: string | null; toStatus: string; reasonCode: string | null; actor: string | null; createdAt: string };

export type LeadDeliveryRoute = {
  id: string;
  locationId: string;
  department: string;
  environment: 'SANDBOX' | 'PRODUCTION';
  enabled: boolean;
  destinationMasked: string | null;
  format: string;
  verified: boolean;
  verifiedAt: string | null;
  productionEnabled: boolean;
};

export const DELIVERIES_BASE = '/ops/lead-deliveries';

export const STATUS_FILTERS: Array<{ id: LeadDeliveryStatus | 'ALL'; label: string }> = [
  { id: 'ALL', label: 'All' },
  { id: 'BLOCKED', label: 'Blocked' },
  { id: 'FAILED', label: 'Failed' },
  { id: 'DEAD', label: 'Stopped retrying' },
  { id: 'ACCEPTED', label: 'Accepted, unconfirmed' },
  { id: 'CRM_REJECTED', label: 'CRM rejected' },
  { id: 'CRM_MATCHED', label: 'In CRM' },
];

export function listPath(filter: LeadDeliveryStatus | 'ALL', locationId?: string): string {
  const q = new URLSearchParams();
  if (filter !== 'ALL') q.set('status', filter);
  if (locationId) q.set('locationId', locationId);
  const s = q.toString();
  return s ? `${DELIVERIES_BASE}?${s}` : DELIVERIES_BASE;
}

/** The forward ladder, in evidence order. Side states (failed, blocked, rejected) are separate. */
export const LADDER: Array<{ status: LeadDeliveryStatus; label: string; evidence: string; at: keyof LeadDeliveryRow }> = [
  { status: 'QUEUED', label: 'Queued', evidence: 'Saved for sending. Nothing has left AMQUR.', at: 'queuedAt' },
  { status: 'SENT', label: 'Sent', evidence: 'Handed to the mail transport. Outcome not yet known.', at: 'sentAt' },
  { status: 'ACCEPTED', label: 'Accepted', evidence: 'The mail server acknowledged it. Not proof of delivery or of a CRM lead.', at: 'acceptedAt' },
  { status: 'DELIVERED', label: 'Delivered', evidence: 'The mail provider reported delivery to the mailbox.', at: 'deliveredAt' },
  { status: 'CRM_PARSED', label: 'CRM parsed', evidence: 'Staff or a reconciliation feed confirmed the CRM read it.', at: 'crmParsedAt' },
  { status: 'CRM_MATCHED', label: 'In CRM', evidence: 'Matched to a CRM record reference.', at: 'crmMatchedAt' },
];

const SUMMARY: Record<LeadDeliveryStatus, string> = {
  QUEUED: 'Waiting to send',
  SENT: 'Sent, awaiting acknowledgement',
  ACCEPTED: 'Accepted by mail server — not confirmed in CRM',
  DELIVERED: 'Delivered to mailbox — not confirmed in CRM',
  CRM_PARSED: 'CRM parsed it — record not yet matched',
  CRM_MATCHED: 'Confirmed in CRM',
  CRM_REJECTED: 'CRM rejected it — needs attention',
  FAILED: 'Send failed — will retry',
  DEAD: 'Stopped retrying — needs attention',
  BLOCKED: 'Not sent — blocked',
};
export const statusSummary = (s: LeadDeliveryStatus): string => SUMMARY[s] ?? s;

export function statusTone(s: LeadDeliveryStatus): 'ok' | 'warn' | 'bad' | 'info' | 'neutral' {
  if (s === 'CRM_MATCHED') return 'ok';
  if (s === 'CRM_REJECTED' || s === 'DEAD') return 'bad';
  if (s === 'FAILED' || s === 'BLOCKED') return 'warn';
  if (s === 'QUEUED' || s === 'SENT') return 'neutral';
  return 'info'; // accepted / delivered / parsed: progress, but not yet proven in the CRM
}

/** Only CRM_MATCHED means the store's CRM has the lead. */
export const isConfirmedInCrm = (s: LeadDeliveryStatus): boolean => s === 'CRM_MATCHED';

/** Leads staff should chase by hand because the CRM is not known to have them. */
export const needsAttention = (s: LeadDeliveryStatus): boolean => ['BLOCKED', 'FAILED', 'DEAD', 'CRM_REJECTED'].includes(s);

const BLOCK_REASONS: Record<string, string> = {
  send_disabled: 'Lead sending is switched off for this deployment.',
  flag_off: 'Lead sending is not turned on for this rooftop.',
  no_consent_basis: 'The customer opted out, or the lead was marked as spam.',
  no_contact_method: 'The lead has no phone or email.',
  no_location: 'The lead is not tied to a rooftop.',
  no_route: 'No destination is set up for this rooftop and department.',
  route_tenant_mismatch: 'The destination belongs to a different rooftop. Nothing was sent.',
  route_disabled: 'The destination is disabled.',
  route_unverified: 'The destination has not been verified with the store’s CRM administrator.',
  route_not_production_enabled: 'The destination is verified but not approved for live sending.',
  route_not_production_environment: 'Only a sandbox destination exists for this rooftop.',
  reserved_destination_in_live: 'The destination is a test address and cannot be used live.',
  sandbox_recipient_not_reserved: 'Sandbox mode only sends to reserved test addresses.',
  smtp_host_not_loopback: 'Sandbox mode only uses the local test mail server.',
  invalid_adf: 'The lead could not be turned into a valid ADF document.',
  sandbox_in_production: 'Live sending is not fully set up, and test delivery is not allowed in production. Nothing was sent.',
  lead_location_changed: 'The lead moved to another rooftop after it was queued. Nothing was sent.',
  production_route_in_sandbox: 'This is a live destination, and this environment only does test delivery. Nothing was sent or stored.',
};
export function blockedReasonText(code: string | null): string {
  if (!code) return 'No reason recorded.';
  return BLOCK_REASONS[code] ?? `Reason code: ${code}`;
}

/** Plain words for how a delivery was handed off. A test hand-off must never read as a real one. */
export function deliveryModeLabel(mode: LeadDeliveryRow['deliveryMode']): string | null {
  if (mode === 'sandbox') return 'Test delivery — not sent to the store';
  if (mode === 'live') return 'Live delivery';
  return null;
}

/** R8: an appointment event that follows a lead (ids, states and codes only). */
export type AppointmentUpdate = {
  id: string;
  appointmentId: string;
  state: 'REQUESTED' | 'SCHEDULED' | 'CONFIRMED' | 'CANCELLED' | 'RESCHEDULED' | 'FAILED';
  status: string;
  reason: string | null;
  sandboxReceipt: boolean;
  deliveryMode: 'sandbox' | 'live' | null;
  sentAt: string | null;
  acceptedAt: string | null;
  createdAt: string;
};

const UPDATE_STATE: Record<AppointmentUpdate['state'], string> = {
  REQUESTED: 'Appointment requested by the customer',
  SCHEDULED: 'Time set by staff (no scheduler confirmation)',
  CONFIRMED: 'Confirmed by the scheduling provider',
  CANCELLED: 'Appointment cancelled',
  RESCHEDULED: 'Appointment moved',
  FAILED: 'Booking did not go through',
};
const UPDATE_STATUS: Record<string, string> = {
  NOT_SENT: 'Not sent — this store’s CRM is not set up to receive appointment updates. Staff see it here only.',
  WAITING_FOR_LEAD: 'Waiting — the lead itself has not been accepted yet.',
  QUEUED: 'Queued to send.',
  SENT: 'Sent, waiting for the mail server.',
  ACCEPTED: 'Accepted by the mail server — not confirmed in the CRM.',
  FAILED: 'Sending failed; it will be retried.',
  DEAD: 'Stopped retrying.',
  BLOCKED: 'Blocked, not sent.',
};

/** What happened to the appointment, and what happened to telling the CRM about it — never merged. */
export function appointmentUpdateText(u: AppointmentUpdate): { what: string; delivery: string } {
  const demo = u.state === 'CONFIRMED' && u.sandboxReceipt;
  const what = demo ? 'Demo scheduler booking (not a real appointment)' : (UPDATE_STATE[u.state] ?? u.state);
  const base = UPDATE_STATUS[u.status] ?? `Status: ${u.status}`;
  const mode = u.status === 'ACCEPTED' || u.status === 'SENT' ? deliveryModeLabel(u.deliveryMode) : null;
  return { what, delivery: [base, mode, u.reason && u.status !== 'NOT_SENT' ? `Reason code: ${u.reason}` : null].filter(Boolean).join(' ') };
}

export type Capability = {
  canReplay: boolean;
  canReconcile: boolean;
  /** SENT with a durable Message-ID — assert relay acceptance without a second send. */
  canAssertAccepted: boolean;
};
/** Mirrors the server's role rules; the server is still the authority. */
export function capability(
  row: Pick<LeadDeliveryRow, 'status'> &
    Partial<Pick<LeadDeliveryRow, 'providerMessageId' | 'lastErrorCode'>>,
  role: string,
): Capability {
  const replayable = ['FAILED', 'DEAD', 'BLOCKED'].includes(row.status);
  const reconcilable = ['ACCEPTED', 'DELIVERED', 'CRM_PARSED'].includes(row.status);
  const durableId = (row.providerMessageId ?? '').startsWith('<lead-delivery.');
  const assertable =
    row.status === 'SENT' &&
    durableId &&
    (row.lastErrorCode === 'send_dispatched' ||
      row.lastErrorCode === 'accepted_record_pending' ||
      row.lastErrorCode == null);
  return {
    canReplay: replayable && ['SUPER_ADMIN', 'ADMIN'].includes(role),
    canReconcile: reconcilable && ['SUPER_ADMIN', 'ADMIN', 'MANAGER'].includes(role),
    canAssertAccepted: assertable && ['SUPER_ADMIN', 'ADMIN'].includes(role),
  };
}

export function reconcileBody(result: 'CRM_PARSED' | 'CRM_MATCHED' | 'CRM_REJECTED', crmRecordRef?: string, note?: string) {
  const ref = (crmRecordRef ?? '').trim().slice(0, 128);
  const n = (note ?? '').trim().slice(0, 300);
  if (result === 'CRM_MATCHED' && !ref) throw new Error('A CRM record reference is required to mark a lead as in the CRM.');
  return { result, ...(ref ? { crmRecordRef: ref } : {}), ...(n ? { note: n } : {}) };
}

export type AssertEvidenceKind = 'mailbox_message_id' | 'smtp_relay_log';

/**
 * Body for assert-accepted. Requires a Message-ID pasted from an external mailbox/relay log
 * (must match the durable id), an explicit external attestation, and a note — a free-text
 * note or ledger echo alone is not enough. CRM match uses reconcile, not assert-accepted.
 */
export function assertAcceptedBody(input: {
  note: string;
  evidenceKind: AssertEvidenceKind;
  evidenceReference: string;
  /** Durable Message-ID on the SENT row; required for mailbox/smtp kinds. */
  durableMessageId?: string | null;
  /** Operator affirms the Message-ID was observed outside AMQUR. */
  externalAttestation: boolean;
}) {
  const n = input.note.trim().slice(0, 300);
  if (n.length < 8) throw new Error('Explain how you verified acceptance (at least 8 characters).');
  if (input.externalAttestation !== true)
    throw new Error('Confirm you observed this Message-ID outside AMQUR before asserting acceptance.');
  const kind = input.evidenceKind;
  if (kind !== 'mailbox_message_id' && kind !== 'smtp_relay_log')
    throw new Error('Choose mailbox or SMTP relay evidence (CRM match uses Found in CRM).');
  const ref = input.evidenceReference.trim().slice(0, 200);
  if (!ref) throw new Error('Paste the Message-ID from the external mailbox or relay log.');
  const durable = (input.durableMessageId ?? '').trim();
  if (!durable) throw new Error('This delivery has no durable Message-ID to match.');
  if (ref !== durable)
    throw new Error('Evidence reference must exactly match the durable Message-ID.');
  return {
    note: n,
    evidenceKind: kind,
    evidenceReference: ref,
    externalAttestation: true as const,
  };
}

export function routeReadiness(r: LeadDeliveryRoute): { label: string; tone: 'ok' | 'warn' | 'neutral' } {
  if (!r.enabled) return { label: 'Disabled', tone: 'neutral' };
  if (r.environment === 'SANDBOX') return { label: 'Sandbox only — test address', tone: 'neutral' };
  if (!r.verified) return { label: 'Not verified — cannot send', tone: 'warn' };
  if (!r.productionEnabled) return { label: 'Verified — not approved for live', tone: 'warn' };
  return { label: 'Verified and approved for live', tone: 'ok' };
}

/** Counts for the header strip. "inCrm" is the only number that means the CRM has the lead. */
export function tally(rows: Array<Pick<LeadDeliveryRow, 'status'>>) {
  return {
    total: rows.length,
    inCrm: rows.filter((r) => isConfirmedInCrm(r.status)).length,
    unconfirmed: rows.filter((r) => ['QUEUED', 'SENT', 'ACCEPTED', 'DELIVERED', 'CRM_PARSED'].includes(r.status)).length,
    attention: rows.filter((r) => needsAttention(r.status)).length,
  };
}

/**
 * Who caused a history entry. The pipeline records its own steps with a `system` actor; anything
 * else is a staff user id, which is not shown (only that a person did it).
 */
export function actorLabel(actor: string | null): string {
  if (!actor || /^(system|worker|outbox|cli)\b/i.test(actor)) return 'automatic';
  return 'by staff';
}
