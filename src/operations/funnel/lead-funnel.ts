/**
 * Lead and appointment funnel for one rooftop (or one tenant), built from evidence columns.
 *
 * The stage names are fixed vocabulary. Each stage counts only what its own evidence proves,
 * so no stage can be read as a later one:
 *   LEAD_CREATED            a lead row exists in AMQUR
 *   LEAD_QUEUED             a delivery to the rooftop's CRM inbox was queued
 *   MAIL_ACCEPTED           the mail server acknowledged it — NOT proof the CRM has it
 *   CRM_RECEIVED            the CRM is known to have parsed it (staff or reconciliation input)
 *   CRM_MATCHED             it was matched to a CRM record reference
 *   APPOINTMENT_REQUESTED   the customer asked for a time
 *   APPOINTMENT_CONFIRMED   a scheduling provider confirmed it (a receipt exists)
 * Sandbox acknowledgements and staff-only confirmations are reported separately and never
 * added into the proven stages.
 */
export const FUNNEL_STAGES = [
  'LEAD_CREATED',
  'LEAD_QUEUED',
  'MAIL_ACCEPTED',
  'CRM_RECEIVED',
  'CRM_MATCHED',
  'APPOINTMENT_REQUESTED',
  'APPOINTMENT_CONFIRMED',
] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export type FunnelCounts = {
  leads: number;
  deliveriesQueued: number;
  /** Acknowledged on a PRODUCTION route. */
  deliveriesAccepted: number;
  /** Acknowledged on a SANDBOX route (reserved test address). */
  deliveriesAcceptedSandbox: number;
  deliveriesCrmReceived: number;
  deliveriesCrmMatched: number;
  deliveriesCrmRejected: number;
  deliveriesBlocked: number;
  deliveriesFailedOrDead: number;
  appointments: number;
  /** CONFIRMED with a provider receipt from a real scheduler. */
  appointmentsProviderConfirmed: number;
  /** CONFIRMED with a receipt from the labelled sandbox scheduler. */
  appointmentsSandboxConfirmed: number;
  /** Marked confirmed by staff, with no provider receipt. */
  appointmentsStaffConfirmed: number;
};

export type FunnelRow = {
  stage: FunnelStage;
  count: number;
  /** What a count at this stage does and does not prove. */
  evidence: string;
};

export type LeadFunnel = {
  windowDays: number;
  since: string;
  stages: FunnelRow[];
  /** Reported beside the funnel, never inside it. */
  notProven: {
    mailAcceptedSandboxOnly: number;
    appointmentsSandboxConfirmed: number;
    appointmentsStaffConfirmedNoReceipt: number;
  };
  needsAttention: {
    crmRejected: number;
    blocked: number;
    failedOrDead: number;
    /** Accepted by mail but not yet known to be in the CRM. */
    acceptedNotConfirmedInCrm: number;
  };
};

const EVIDENCE: Record<FunnelStage, string> = {
  LEAD_CREATED: 'Lead saved in AMQUR. Nothing has been sent anywhere.',
  LEAD_QUEUED: 'Queued for the rooftop’s CRM inbox. Not yet sent.',
  MAIL_ACCEPTED:
    'The mail server acknowledged the message. This is not delivery and not a CRM lead.',
  CRM_RECEIVED:
    'The CRM is known to have parsed it (recorded by staff or a reconciliation feed).',
  CRM_MATCHED: 'Matched to a CRM record reference.',
  APPOINTMENT_REQUESTED:
    'The customer asked for a time. Nothing is booked by this alone.',
  APPOINTMENT_CONFIRMED:
    'A scheduling provider confirmed it and a receipt is on file.',
};

const n = (v: number) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

export function clampWindowDays(raw: unknown): number {
  const v = Number(raw);
  if (!Number.isFinite(v)) return 7;
  return Math.min(90, Math.max(1, Math.floor(v)));
}

export function buildLeadFunnel(
  c: FunnelCounts,
  windowDays: number,
  since: Date,
): LeadFunnel {
  const accepted = n(c.deliveriesAccepted);
  const received = Math.min(n(c.deliveriesCrmReceived), accepted);
  const matched = Math.min(n(c.deliveriesCrmMatched), received);
  const count: Record<FunnelStage, number> = {
    LEAD_CREATED: n(c.leads),
    LEAD_QUEUED: n(c.deliveriesQueued),
    MAIL_ACCEPTED: accepted,
    CRM_RECEIVED: received,
    CRM_MATCHED: matched,
    APPOINTMENT_REQUESTED: n(c.appointments),
    APPOINTMENT_CONFIRMED: n(c.appointmentsProviderConfirmed),
  };
  return {
    windowDays,
    since: since.toISOString(),
    stages: FUNNEL_STAGES.map((stage) => ({
      stage,
      count: count[stage],
      evidence: EVIDENCE[stage],
    })),
    notProven: {
      mailAcceptedSandboxOnly: n(c.deliveriesAcceptedSandbox),
      appointmentsSandboxConfirmed: n(c.appointmentsSandboxConfirmed),
      appointmentsStaffConfirmedNoReceipt: n(c.appointmentsStaffConfirmed),
    },
    needsAttention: {
      crmRejected: n(c.deliveriesCrmRejected),
      blocked: n(c.deliveriesBlocked),
      failedOrDead: n(c.deliveriesFailedOrDead),
      acceptedNotConfirmedInCrm: Math.max(0, accepted - received),
    },
  };
}
