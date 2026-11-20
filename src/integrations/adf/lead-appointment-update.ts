/**
 * R8 — "lead first, appointment as a separate update" (PROPOSED policy, sandbox-verified only).
 *
 * Pure rules for the appointment update that follows a lead delivery. Nothing here talks to a
 * database, a transport or a CRM. See docs/ADF_LEAD_DELIVERY.md, section R8.
 *
 * The words stay distinct end to end: requested ≠ scheduled ≠ confirmed ≠ cancelled ≠ failed.
 */

/** One update per (lead, appointment, state) at most. */
export const APPOINTMENT_UPDATE_STATES = [
  /** The customer asked; nobody has confirmed anything. */
  'REQUESTED',
  /** Dealership staff set a time. No scheduling-provider receipt exists. */
  'SCHEDULED',
  /** A valid CONFIRMED scheduling-provider receipt exists for this appointment. */
  'CONFIRMED',
  'CANCELLED',
  /** This appointment was replaced by a new one (which gets its own updates). */
  'RESCHEDULED',
  /** The scheduling provider could not book; nothing is booked. */
  'FAILED',
] as const;
export type AppointmentUpdateState = (typeof APPOINTMENT_UPDATE_STATES)[number];

export type UpdateAppointment = {
  id: string;
  status: string;
  type: string;
  provider: string;
  externalProviderId: string | null;
  providerStatus: string | null;
  cancelReason: string | null;
  requestedDate: string | null;
  requestedTime: string | null;
  scheduledAt: Date | null;
  timezone: string;
};

export type UpdateReceipt = {
  id: string;
  appointmentId: string;
  provider: string;
  providerRef: string | null;
  status: string;
  confirmedStart: Date | null;
  sandbox: boolean;
  receivedAt: Date;
};

const nonEmpty = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0;

/**
 * The VALID provider receipt behind a confirmation, or null. Valid means: it belongs to this
 * appointment, its status is exactly CONFIRMED, it carries a provider reference, and both the
 * provider and the reference are the ones the appointment row itself records. Anything else —
 * a PENDING / UNKNOWN / FAILED receipt, a receipt of another appointment, a reference that
 * does not match — is not a confirmation.
 */
export function confirmedReceiptOf(
  appt: Pick<UpdateAppointment, 'id' | 'provider' | 'externalProviderId'>,
  receipts: readonly UpdateReceipt[],
): UpdateReceipt | null {
  const valid = receipts.filter(
    (r) =>
      r.appointmentId === appt.id &&
      r.status === 'CONFIRMED' &&
      nonEmpty(r.providerRef) &&
      appt.provider !== 'NONE' &&
      r.provider === appt.provider &&
      r.providerRef === appt.externalProviderId,
  );
  if (valid.length === 0) return null;
  return valid.reduce((a, b) => (b.receivedAt > a.receivedAt ? b : a));
}

/** True when ANY receipt of the appointment came from a sandbox / demo scheduler. */
export function hasSandboxReceipt(
  appt: Pick<UpdateAppointment, 'id'>,
  receipts: readonly UpdateReceipt[],
): boolean {
  return receipts.some(
    (r) => r.appointmentId === appt.id && r.sandbox === true,
  );
}

/**
 * The single derivation of "which update state is this appointment in right now?". Because it
 * reads only the appointment's CURRENT row and receipts, calling it again for a duplicate /
 * replayed / late event yields the same state — the caller's unique key does the rest.
 *
 *  - REQUESTED / PENDING_CONFIRMATION → REQUESTED, or FAILED when the provider attempt failed
 *    (the request itself stays open for staff);
 *  - CONFIRMED → CONFIRMED only with a valid provider receipt, otherwise SCHEDULED (a staff
 *    confirmation is never worded as a provider confirmation);
 *  - CANCELLED → CANCELLED; a slot the provider refused (`provider_unavailable:*`) is FAILED,
 *    and only worth an update when the appointment was already reported (`previouslyReported`)
 *    — otherwise the customer simply picked another slot and nothing was ever claimed;
 *  - RESCHEDULED → RESCHEDULED;
 *  - COMPLETED / NO_SHOW / anything unknown → no update.
 */
export function deriveAppointmentUpdateState(
  appt: UpdateAppointment,
  receipts: readonly UpdateReceipt[],
  opts: { previouslyReported?: boolean } = {},
): AppointmentUpdateState | null {
  switch (appt.status) {
    case 'REQUESTED':
    case 'PENDING_CONFIRMATION':
      return (appt.providerStatus ?? '').startsWith('FAILED:')
        ? 'FAILED'
        : 'REQUESTED';
    case 'CONFIRMED':
      return confirmedReceiptOf(appt, receipts) ? 'CONFIRMED' : 'SCHEDULED';
    case 'CANCELLED':
      if ((appt.cancelReason ?? '').startsWith('provider_unavailable'))
        return opts.previouslyReported ? 'FAILED' : null;
      return 'CANCELLED';
    case 'RESCHEDULED':
      return 'RESCHEDULED';
    default:
      return null;
  }
}

export function appointmentUpdateIdempotencyKey(p: {
  leadId: string;
  appointmentId: string;
  state: AppointmentUpdateState;
}): string {
  return `lead-appointment-update:v1:${p.leadId}:${p.appointmentId}:${p.state}`;
}

/** The same lead identity the original lead delivery carried — never a new one. */
export const leadRefFor = (leadId: string): string => `amqur-lead-${leadId}`;
export const appointmentRefFor = (appointmentId: string): string =>
  `amqur-appt-${appointmentId}`;

export type UpdateTextRefusal =
  /** A "confirmed" update without a valid CONFIRMED provider receipt is never written. */
  | 'no_provider_receipt'
  /** A sandbox / demo booking is never sent on a live route, in any wording. */
  | 'sandbox_booking_in_live';

export type UpdateTextPlan =
  | { ok: true; text: string; demo: boolean }
  | { ok: false; reason: UpdateTextRefusal };

function whenText(
  appt: UpdateAppointment,
  state: AppointmentUpdateState,
  receipt: UpdateReceipt | null,
): string {
  const instant =
    state === 'CONFIRMED'
      ? (receipt?.confirmedStart ?? appt.scheduledAt)
      : state === 'SCHEDULED'
        ? appt.scheduledAt
        : null;
  if (instant) return `${instant.toISOString()} (${appt.timezone})`;
  return [appt.requestedDate, appt.requestedTime].filter(Boolean).join(' ');
}

/**
 * The one place the update's appointment line is worded.
 *
 * The capitalised word CONFIRMED appears ONLY when all of these hold: the state is CONFIRMED, a
 * valid provider receipt backs it, that receipt is not a sandbox receipt, and the hand-off is a
 * live one. In a sandbox hand-off the same state is worded as a demo booking. A sandbox booking
 * on a live route is refused outright.
 */
export function planAppointmentUpdateText(p: {
  state: AppointmentUpdateState;
  appointment: UpdateAppointment;
  receipts: readonly UpdateReceipt[];
  mode: 'sandbox' | 'live';
}): UpdateTextPlan {
  const receipt = confirmedReceiptOf(p.appointment, p.receipts);
  if (p.state === 'CONFIRMED' && !receipt)
    return { ok: false, reason: 'no_provider_receipt' };
  const sandboxBooking = hasSandboxReceipt(p.appointment, p.receipts);
  if (p.mode === 'live' && sandboxBooking)
    return { ok: false, reason: 'sandbox_booking_in_live' };
  const demo = sandboxBooking || p.mode !== 'live';
  const detail = [p.appointment.type, whenText(p.appointment, p.state, receipt)]
    .filter(Boolean)
    .join(' ');
  const suffix = detail ? ` (${detail})` : '';
  const demoNote = demo ? ' [sandbox demo - not a real appointment]' : '';
  switch (p.state) {
    case 'REQUESTED':
      return {
        ok: true,
        demo,
        text: `REQUESTED by customer - not confirmed, dealership must confirm${suffix}${demoNote}`,
      };
    case 'SCHEDULED':
      return {
        ok: true,
        demo,
        text: `SCHEDULED by dealership staff - no scheduling-provider receipt${suffix}${demoNote}`,
      };
    case 'CONFIRMED':
      return demo
        ? {
            ok: true,
            demo,
            text: `DEMO BOOKING ONLY - sandbox, not a real appointment, nothing is booked with the dealership${suffix}`,
          }
        : {
            ok: true,
            demo,
            text: `CONFIRMED by scheduling provider${suffix}, provider reference ${receipt?.providerRef ?? ''}`,
          };
    case 'CANCELLED':
      return {
        ok: true,
        demo,
        text: `CANCELLED - this appointment is no longer expected${suffix}${demoNote}`,
      };
    case 'RESCHEDULED':
      return {
        ok: true,
        demo,
        text: `RESCHEDULED - the previous time no longer applies${suffix}; the new time is reported in its own update${demoNote}`,
      };
    case 'FAILED':
      return {
        ok: true,
        demo,
        text: `FAILED to book with the scheduling provider - nothing is booked, dealership must contact the customer${suffix}${demoNote}`,
      };
  }
}

/** Original-lead statuses after which an update may follow. CRM_REJECTED is deliberately absent. */
export const LEAD_ACCEPTED_STATUSES = [
  'ACCEPTED',
  'DELIVERED',
  'CRM_PARSED',
  'CRM_MATCHED',
] as const;

export type LeadStandingForUpdate =
  | { kind: 'send' }
  /** Hold the update (nothing is sent) until the original lead delivery is accepted. */
  | { kind: 'wait'; reason: string }
  /** The lead never reached the CRM as a lead: an update would create an orphan. */
  | { kind: 'refuse'; reason: string };

/**
 * QUEUE / SKIP RULE. An update is only ever sent AFTER the original lead delivery was accepted
 * by the same kind of hand-off (a sandbox acknowledgement does not count on a live route):
 *
 *  - accepted (ACCEPTED / DELIVERED / CRM_PARSED / CRM_MATCHED) → send;
 *  - CRM_REJECTED → refuse: the CRM has no such lead, an update could only become a new one;
 *  - anything else (QUEUED, SENT, FAILED, BLOCKED, DEAD, sandbox-acknowledged while live)
 *    → wait. The update is HELD, not dropped: the usual reason is simply that the appointment
 *    was made seconds after the lead was queued, and dropping it would lose the appointment for
 *    the CRM for good. It is released when (and only if) the lead is accepted.
 */
export function leadStandingForUpdate(p: {
  leadDeliveryStatus: string;
  acknowledgementCounts: boolean;
}): LeadStandingForUpdate {
  if (p.leadDeliveryStatus === 'CRM_REJECTED')
    return { kind: 'refuse', reason: 'lead_rejected_by_crm' };
  const accepted = (LEAD_ACCEPTED_STATUSES as readonly string[]).includes(
    p.leadDeliveryStatus,
  );
  if (accepted && p.acknowledgementCounts) return { kind: 'send' };
  return {
    kind: 'wait',
    reason: accepted
      ? 'lead_acknowledged_in_sandbox_only'
      : `lead_${p.leadDeliveryStatus.toLowerCase()}`,
  };
}
