/**
 * Canonical lead DTO for ADF 1.0 serialization. Every optional field is OMITTED from the XML
 * when unknown — the serializer never emits placeholder or invented vehicle/customer facts.
 */
export type AdfVehicleInterest =
  | 'buy'
  | 'lease'
  | 'sell'
  | 'trade-in'
  | 'test-drive';

export type AdfVehicle = {
  interest: AdfVehicleInterest;
  /** Only when the condition is actually known. */
  status?: 'new' | 'used';
  year?: number;
  make?: string;
  model?: string;
  trim?: string;
  vin?: string;
  stock?: string;
};

export type AdfPhoneType = 'voice' | 'cellphone';

export type AdfCustomer = {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  phoneType?: AdfPhoneType;
};

/**
 * Mirrors Appointment.status. R8: the LEAD document never words an appointment as confirmed —
 * a confirmation is a separate event, reported (if at all) by an appointment update that is
 * backed by a scheduling-provider receipt.
 */
export type AdfAppointmentFacts = {
  status:
    | 'REQUESTED'
    | 'PENDING_CONFIRMATION'
    | 'CONFIRMED'
    | 'RESCHEDULED'
    | 'CANCELLED'
    | 'COMPLETED'
    | 'NO_SHOW';
  /** True only when a human or a verified calendar confirmed the slot. */
  availabilityVerified: boolean;
  type?: string;
  /** Customer-requested date/time as plain text. */
  when?: string;
};

/**
 * R8 appointment update: marks the document as a FOLLOW-UP to a lead that was already sent.
 * `text` is the complete, already-decided appointment wording (see lead-appointment-update.ts).
 */
export type AdfFollowUpFacts = {
  /** The lead reference of the ORIGINAL delivery, repeated verbatim. */
  leadRef: string;
  appointmentRef: string;
  state: string;
  text: string;
  /** ISO-8601 instant the update was recorded (stable across retries). */
  recordedAt: string;
};

/** true = recorded opt-in, false = recorded opt-out, null = nothing recorded. */
export type AdfConsentSummary = {
  text: boolean | null;
  email: boolean | null;
  call: boolean | null;
};

export type AdfCommentFacts = {
  department: 'SALES' | 'SERVICE' | 'PARTS';
  requestedAction?: string;
  preferredContact?: string;
  appointment?: AdfAppointmentFacts | null;
  /** Present ONLY on an appointment update; replaces the lead's own appointment line. */
  followUp?: AdfFollowUpFacts;
  consent: AdfConsentSummary;
  source?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
};

export type AdfLeadDto = {
  /** Stable AMQUR lead reference (never a CRM secret, never contact data). */
  leadRef: string;
  /** `<id source="…">` */
  idSource: string;
  /** ISO-8601 instant. */
  requestDate: string;
  vehicles: AdfVehicle[];
  customer: AdfCustomer;
  comments: AdfCommentFacts;
  /** The rooftop's own name (`<vendor><vendorname>`). */
  vendorName: string;
  /** `<provider><name>` */
  providerName: string;
  /**
   * `<prospect status="…">` per ADF 1.0 (`new` | `resend`). A lead document is always `new`
   * (the default). Only an appointment update — the same lead reference sent again with a
   * follow-up comment — is `resend`.
   */
  prospectStatus?: 'new' | 'resend';
};

export const ADF_VERSION = '1.0';
/** Hard cap on the serialized document (bytes, UTF-8). */
export const ADF_DEFAULT_MAX_BYTES = 64 * 1024;
