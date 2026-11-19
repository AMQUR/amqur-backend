/**
 * Structured "sales desk" cards for the widget (flag `salesDeskCards`, default off).
 * These shapes are the server half of the widget contract — see docs/CHAT_STREAM_CONTRACT.md.
 */
export type ContactChannel = 'EMAIL' | 'CALL' | 'TEXT';
export type AppointmentWindow = 'morning' | 'afternoon' | 'evening';
export type SalesDeskLang = 'en' | 'es';

export type LeadFormPurpose =
  | 'sales'
  | 'test_drive'
  | 'service'
  | 'parts'
  | 'callback';

export type LeadFormCard = {
  kind: 'lead_form';
  id: string;
  purpose: LeadFormPurpose;
  rooftopName: string;
  vehicleLabel: string | null;
  vin: string | null;
  /** Channels this rooftop can actually use right now. */
  channels: ContactChannel[];
  /** Versioned, server-authored consent wording per offered channel. */
  consent: { version: string; text: Partial<Record<ContactChannel, string>> };
  reason: string;
};

/** One bookable time. `id` is opaque, server-issued and bound to the conversation. */
export type AppointmentSlot = {
  id: string;
  start: string;
  end: string | null;
  expiresAt: string | null;
};

export type PickerDepartment = 'sales' | 'service' | 'parts';

export type AppointmentPickerCard = {
  kind: 'appointment_picker';
  id: string;
  department: PickerDepartment;
  purpose: string;
  rooftopName: string;
  timezone: string;
  /**
   * Server time when the card was issued. The widget measures its own clock against this, so a
   * wrong device clock cannot hide slots that are still on offer (the server is the authority
   * on expiry either way).
   */
  serverNow: string;
  /**
   * provider_slots — availability from an authorised scheduler; choosing one books it.
   * request_only   — no scheduler; the customer states a preference and staff confirm.
   * (external_link is part of the widget contract but is not produced by this server: no
   *  per-location scheduler URL exists in configuration.)
   */
  mode: 'provider_slots' | 'request_only';
  slots?: AppointmentSlot[];
  /** ISO dates (yyyy-mm-dd, store timezone) offered in request_only mode. */
  days?: string[];
  vehicleLabel: string | null;
  vin: string | null;
  /** True when availability comes from the labelled sandbox scheduler. */
  sandbox?: boolean;
};

export type PickerAppointmentType = 'SALES' | 'TEST_DRIVE' | 'SERVICE';

/** What the server remembers about a picker it offered (conversation state, never client). */
export type OfferedPicker = {
  id: string;
  type: PickerAppointmentType;
  mode: 'provider_slots' | 'request_only';
  /** Location the picker was issued for — a selection must come from the same rooftop. */
  locationId: string | null;
  issuedAt: string;
  days?: string[];
  connectionId?: string;
  provider?: string;
  slots?: Array<{
    id: string;
    startUtc: string;
    endUtc: string | null;
    expiresAt: string;
    providerSlotId?: string;
  }>; /**
   * Set once a booking was saved from a provider-slot picker of this kind: the card is spent.
   * Only `bookedSlotId` (when the booking came from THIS card) may be submitted again — as an
   * idempotent replay of the same booking — and every other slot is refused.
   */
  settled?: boolean;
  bookedSlotId?: string;
};

export type OfferedLeadForm = {
  id: string;
  purpose: LeadFormPurpose;
  channels: ContactChannel[];
  consentVersion: string;
  /**
   * When the server last showed this form. A submission is accepted only within
   * LEAD_FORM_TTL_MS of it.
   */
  issuedAt: string;
  /**
   * Language the form (and its consent wording) was ISSUED in. The stored consent wording is
   * taken from here, never from the language a client claims at submit time. Absent on forms
   * offered before this field existed.
   */
  language?: SalesDeskLang;
  /** Set once a valid submission was stored — a repeat submit is a no-op. */
  submittedAt?: string;
};

export type SalesDeskState = {
  leadForm?: OfferedLeadForm;
  /** Most recent pickers (newest last); older ones stop being selectable. */
  pickers?: OfferedPicker[];
};
