import {
  APPOINTMENT_UPDATE_STATES,
  appointmentUpdateIdempotencyKey,
  AppointmentUpdateState,
  confirmedReceiptOf,
  deriveAppointmentUpdateState,
  leadRefFor,
  leadStandingForUpdate,
  planAppointmentUpdateText,
  UpdateAppointment,
  UpdateReceipt,
} from './lead-appointment-update';
import { mapLeadToAdf, MapperLead } from './adf-lead-mapper';
import { serializeAdf } from './adf-serializer';
import { validateAdfRoundTrip, validateAdfXml } from './adf-validator';
import { AdfLeadDto } from './adf.types';

/** Synthetic, TEST-ONLY data. */
const appt = (over: Partial<UpdateAppointment> = {}): UpdateAppointment => ({
  id: 'appt1',
  status: 'REQUESTED',
  type: 'TEST_DRIVE',
  provider: 'NONE',
  externalProviderId: null,
  providerStatus: null,
  cancelReason: null,
  requestedDate: '2026-11-21',
  requestedTime: '15:00',
  scheduledAt: null,
  timezone: 'America/Chicago',
  ...over,
});
const receipt = (over: Partial<UpdateReceipt> = {}): UpdateReceipt => ({
  id: 'r1',
  appointmentId: 'appt1',
  provider: 'TEKION',
  providerRef: 'BK-1',
  status: 'CONFIRMED',
  confirmedStart: new Date('2026-11-21T21:00:00Z'),
  sandbox: false,
  receivedAt: new Date('2026-11-19T10:00:00Z'),
  ...over,
});
const confirmedAppt = (over: Partial<UpdateAppointment> = {}) =>
  appt({
    status: 'CONFIRMED',
    provider: 'TEKION',
    externalProviderId: 'BK-1',
    scheduledAt: new Date('2026-11-21T21:00:00Z'),
    ...over,
  });

describe('R8 appointment update — pure rules', () => {
  describe('a valid provider receipt', () => {
    it('is a CONFIRMED receipt of THIS appointment whose provider and reference match the appointment row', () => {
      expect(confirmedReceiptOf(confirmedAppt(), [receipt()])?.id).toBe('r1');
    });

    it.each([
      ['PENDING receipt', receipt({ status: 'PENDING' })],
      ['UNKNOWN receipt', receipt({ status: 'UNKNOWN' })],
      ['FAILED receipt', receipt({ status: 'FAILED' })],
      ['receipt without a reference', receipt({ providerRef: null })],
      ["another appointment's receipt", receipt({ appointmentId: 'other' })],
      [
        'a reference the appointment does not hold',
        receipt({ providerRef: 'BK-2' }),
      ],
      ['another provider', receipt({ provider: 'MOCK' })],
    ])('%s is not a confirmation', (_n, r) => {
      expect(confirmedReceiptOf(confirmedAppt(), [r])).toBeNull();
    });

    it('an appointment with provider NONE has no provider confirmation at all', () => {
      expect(
        confirmedReceiptOf(confirmedAppt({ provider: 'NONE' }), [receipt()]),
      ).toBeNull();
    });
  });

  describe('state derivation (requested ≠ scheduled ≠ confirmed ≠ cancelled ≠ failed)', () => {
    it('a request is REQUESTED; a pending provider answer is still only REQUESTED', () => {
      expect(deriveAppointmentUpdateState(appt(), [])).toBe('REQUESTED');
      expect(
        deriveAppointmentUpdateState(
          appt({ status: 'PENDING_CONFIRMATION', provider: 'TEKION' }),
          [receipt({ status: 'PENDING' })],
        ),
      ).toBe('REQUESTED');
    });

    it('an UNKNOWN provider outcome is not a failure and not a confirmation', () => {
      expect(
        deriveAppointmentUpdateState(
          appt({
            provider: 'TEKION',
            providerStatus: 'UNKNOWN:provider_timeout',
          }),
          [receipt({ status: 'UNKNOWN', providerRef: null })],
        ),
      ).toBe('REQUESTED');
    });

    it('a failed provider attempt is FAILED (the request itself stays open)', () => {
      expect(
        deriveAppointmentUpdateState(
          appt({ provider: 'TEKION', providerStatus: 'FAILED:provider_error' }),
          [receipt({ status: 'FAILED', providerRef: null })],
        ),
      ).toBe('FAILED');
    });

    it('CONFIRMED needs a valid receipt; a staff confirmation without one is SCHEDULED', () => {
      expect(deriveAppointmentUpdateState(confirmedAppt(), [receipt()])).toBe(
        'CONFIRMED',
      );
      expect(deriveAppointmentUpdateState(confirmedAppt(), [])).toBe(
        'SCHEDULED',
      );
      expect(
        deriveAppointmentUpdateState(
          confirmedAppt({ provider: 'NONE', externalProviderId: null }),
          [],
        ),
      ).toBe('SCHEDULED');
      // A CONFIRMED status with only a PENDING receipt is still not a provider confirmation.
      expect(
        deriveAppointmentUpdateState(confirmedAppt(), [
          receipt({ status: 'PENDING' }),
        ]),
      ).toBe('SCHEDULED');
    });

    it('cancelled and rescheduled are their own states', () => {
      expect(
        deriveAppointmentUpdateState(
          appt({ status: 'CANCELLED', cancelReason: 'chat' }),
          [],
        ),
      ).toBe('CANCELLED');
      expect(
        deriveAppointmentUpdateState(appt({ status: 'RESCHEDULED' }), []),
      ).toBe('RESCHEDULED');
    });

    it('a slot the provider refused is reported (as FAILED) only if the appointment was reported before', () => {
      const refused = appt({
        status: 'CANCELLED',
        cancelReason: 'provider_unavailable:slot_taken',
      });
      expect(deriveAppointmentUpdateState(refused, [])).toBeNull();
      expect(
        deriveAppointmentUpdateState(refused, [], { previouslyReported: true }),
      ).toBe('FAILED');
    });

    it('completed / no-show / unknown statuses produce no update', () => {
      for (const status of ['COMPLETED', 'NO_SHOW', 'SOMETHING_NEW'])
        expect(deriveAppointmentUpdateState(appt({ status }), [])).toBeNull();
    });

    it('is stable: the same row and receipts always derive the same state (replay-safe)', () => {
      const a = confirmedAppt();
      const rs = [receipt()];
      expect(
        new Set(
          Array.from({ length: 5 }, () => deriveAppointmentUpdateState(a, rs)),
        ).size,
      ).toBe(1);
    });
  });

  describe('identity', () => {
    it('one key per (lead, appointment, state); the lead reference is the original one', () => {
      const key = (state: AppointmentUpdateState, appointmentId = 'a1') =>
        appointmentUpdateIdempotencyKey({ leadId: 'L1', appointmentId, state });
      expect(key('CONFIRMED')).toBe(key('CONFIRMED'));
      expect(new Set(APPOINTMENT_UPDATE_STATES.map((s) => key(s))).size).toBe(
        APPOINTMENT_UPDATE_STATES.length,
      );
      expect(key('CONFIRMED', 'a2')).not.toBe(key('CONFIRMED'));
      expect(leadRefFor('L1')).toBe('amqur-lead-L1');
    });
  });

  describe('wording', () => {
    const text = (
      state: AppointmentUpdateState,
      a: UpdateAppointment,
      receipts: UpdateReceipt[],
      mode: 'sandbox' | 'live',
    ) => planAppointmentUpdateText({ state, appointment: a, receipts, mode });

    it('says CONFIRMED only for a non-sandbox CONFIRMED receipt on a live hand-off', () => {
      expect(text('CONFIRMED', confirmedAppt(), [receipt()], 'live')).toEqual({
        ok: true,
        demo: false,
        text: 'CONFIRMED by scheduling provider (TEST_DRIVE 2026-11-21T21:00:00.000Z (America/Chicago)), provider reference BK-1',
      });
    });

    it('never writes a confirmation without a valid provider receipt', () => {
      for (const mode of ['sandbox', 'live'] as const) {
        expect(text('CONFIRMED', confirmedAppt(), [], mode)).toEqual({
          ok: false,
          reason: 'no_provider_receipt',
        });
        expect(
          text(
            'CONFIRMED',
            confirmedAppt(),
            [receipt({ status: 'PENDING' })],
            mode,
          ),
        ).toEqual({ ok: false, reason: 'no_provider_receipt' });
      }
    });

    it('a sandbox receipt is worded as a demo booking in sandbox and refused outright on a live route', () => {
      const sbx = [
        receipt({ sandbox: true, provider: 'MOCK', providerRef: 'SBX-1' }),
      ];
      const a = confirmedAppt({
        provider: 'MOCK',
        externalProviderId: 'SBX-1',
      });
      const demo = text('CONFIRMED', a, sbx, 'sandbox');
      expect(demo).toMatchObject({ ok: true, demo: true });
      expect(demo.ok && demo.text).toMatch(/^DEMO BOOKING ONLY/);
      expect(demo.ok && demo.text).toContain('not a real appointment');
      expect(demo.ok && demo.text).not.toMatch(/CONFIRMED/);
      for (const state of APPOINTMENT_UPDATE_STATES)
        expect(text(state, a, sbx, 'live')).toEqual({
          ok: false,
          reason: 'sandbox_booking_in_live',
        });
    });

    it('a real receipt handed off in sandbox mode is still worded as a demo, never as a confirmation', () => {
      const t = text('CONFIRMED', confirmedAppt(), [receipt()], 'sandbox');
      expect(t.ok && t.text).toMatch(/^DEMO BOOKING ONLY/);
      expect(t.ok && t.text).not.toMatch(/CONFIRMED/);
    });

    it('every other state has its own word and never the word CONFIRMED', () => {
      const words: Record<string, RegExp> = {
        REQUESTED:
          /^REQUESTED by customer - not confirmed, dealership must confirm \(TEST_DRIVE 2026-11-21 15:00\)$/,
        SCHEDULED:
          /^SCHEDULED by dealership staff - no scheduling-provider receipt \(TEST_DRIVE 2026-11-21T21:00:00.000Z \(America\/Chicago\)\)$/,
        CANCELLED:
          /^CANCELLED - this appointment is no longer expected \(TEST_DRIVE 2026-11-21 15:00\)$/,
        RESCHEDULED:
          /^RESCHEDULED - the previous time no longer applies \(TEST_DRIVE 2026-11-21 15:00\); the new time is reported in its own update$/,
        FAILED:
          /^FAILED to book with the scheduling provider - nothing is booked, dealership must contact the customer \(TEST_DRIVE 2026-11-21 15:00\)$/,
      };
      const seen = new Set<string>();
      for (const [state, re] of Object.entries(words)) {
        const a =
          state === 'SCHEDULED'
            ? confirmedAppt({ provider: 'NONE', externalProviderId: null })
            : appt();
        const t = text(state as AppointmentUpdateState, a, [], 'live');
        expect(t.ok && t.text).toMatch(re);
        expect(t.ok && t.text).not.toMatch(/CONFIRMED/);
        if (t.ok) seen.add(t.text.split(' ')[0]);
        // The sandbox hand-off of the same state is labelled as a demo.
        const s = text(state as AppointmentUpdateState, a, [], 'sandbox');
        expect(s.ok && s.text).toContain(
          '[sandbox demo - not a real appointment]',
        );
      }
      expect([...seen].sort()).toEqual(
        ['CANCELLED', 'FAILED', 'REQUESTED', 'RESCHEDULED', 'SCHEDULED'].sort(),
      );
    });
  });

  describe('queue / skip rule — never before the original lead was accepted', () => {
    const standing = (
      leadDeliveryStatus: string,
      acknowledgementCounts = true,
    ) => leadStandingForUpdate({ leadDeliveryStatus, acknowledgementCounts });

    it.each(['ACCEPTED', 'DELIVERED', 'CRM_PARSED', 'CRM_MATCHED'])(
      'lead %s ⇒ the update may be sent',
      (s) => expect(standing(s)).toEqual({ kind: 'send' }),
    );

    it.each(['QUEUED', 'SENT', 'FAILED', 'BLOCKED', 'DEAD'])(
      'lead %s ⇒ the update is held, not sent and not dropped',
      (s) =>
        expect(standing(s)).toEqual({
          kind: 'wait',
          reason: `lead_${s.toLowerCase()}`,
        }),
    );

    it('a lead the CRM rejected never gets an update (it could only become a new lead)', () => {
      expect(standing('CRM_REJECTED')).toEqual({
        kind: 'refuse',
        reason: 'lead_rejected_by_crm',
      });
    });

    it('a sandbox acknowledgement does not count once the environment is live', () => {
      expect(standing('ACCEPTED', false)).toEqual({
        kind: 'wait',
        reason: 'lead_acknowledged_in_sandbox_only',
      });
    });
  });
});

describe('R8 appointment update — the follow-up ADF document', () => {
  const lead: MapperLead = {
    id: 'lead1',
    createdAt: new Date('2026-11-18T10:00:00Z'),
    firstName: 'Synthetic',
    lastName: 'Customer',
    email: 'synthetic@example.invalid',
    phone: '312-555-0142',
    interestedVin: null,
    interestedStock: null,
    preferredContact: 'phone',
    leaseVsPurchase: null,
    consentToText: false,
    consentToEmail: false,
    consentToCall: false,
    optOutAt: null,
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    source: 'widget',
    nextBestAction: null,
  };
  const leadDto = (): AdfLeadDto =>
    mapLeadToAdf({
      lead,
      department: 'SALES',
      vendorName: 'Jeep of Chicago (synthetic)',
      providerName: 'AMQUR AI',
      vehicle: null,
      appointment: null,
    });
  const followUp = (text: string, state = 'CONFIRMED'): AdfLeadDto => {
    const base = leadDto();
    return {
      ...base,
      prospectStatus: 'resend',
      comments: {
        ...base.comments,
        followUp: {
          leadRef: base.leadRef,
          appointmentRef: 'amqur-appt-appt1',
          state,
          text,
          recordedAt: '2026-11-19T10:00:00.000Z',
        },
      },
    };
  };

  it('keeps the original lead identity: same <id>, same request date, prospect status "resend"', () => {
    const original = serializeAdf(leadDto());
    const update = serializeAdf(
      followUp('REQUESTED by customer - not confirmed'),
    );
    const idLine = '<id sequence="1" source="AMQUR">amqur-lead-lead1</id>';
    expect(original).toContain(idLine);
    expect(update).toContain(idLine);
    expect(original).toContain('<prospect status="new">');
    expect(update).toContain('<prospect status="resend">');
    expect(update).toContain(
      '<requestdate>2026-11-18T10:00:00.000Z</requestdate>',
    );
    expect(update).toContain(
      '<comments>APPOINTMENT UPDATE for existing lead amqur-lead-lead1 - follow-up to a lead already sent, NOT a new lead; Department: SALES; Appointment: REQUESTED by customer - not confirmed; Appointment reference: amqur-appt-appt1; Update: CONFIRMED recorded 2026-11-19T10:00:00.000Z; Consent: text=not recorded, email=not recorded, call=not recorded</comments>',
    );
  });

  it('passes the hardened validator and the round-trip check — only as a "resend"', () => {
    const dto = followUp(
      'CANCELLED - this appointment is no longer expected',
      'CANCELLED',
    );
    const xml = serializeAdf(dto);
    expect(validateAdfRoundTrip(dto, xml)).toMatchObject({
      ok: true,
      summary: { prospectStatus: 'resend', leadRef: 'amqur-lead-lead1' },
    });
    // The validator's default is unchanged: a document is a NEW lead unless asked otherwise.
    expect(validateAdfXml(xml)).toEqual({
      ok: false,
      code: 'adf_prospect_status',
    });
    expect(validateAdfXml(xml, { prospectStatus: 'resend' })).toMatchObject({
      ok: true,
    });
    // …and a lead document can never pass as an update.
    const leadXml = serializeAdf(leadDto());
    expect(validateAdfXml(leadXml)).toMatchObject({
      ok: true,
      summary: { prospectStatus: 'new' },
    });
    expect(validateAdfXml(leadXml, { prospectStatus: 'resend' })).toEqual({
      ok: false,
      code: 'adf_prospect_status',
    });
  });

  it('hostile text in the update line cannot break out of the comment', () => {
    const dto = followUp('x</comments><id>forged</id> & "q" <!ENTITY e "x">');
    const xml = serializeAdf(dto);
    expect(xml).not.toContain('<id>forged</id>');
    expect(validateAdfRoundTrip(dto, xml)).toMatchObject({ ok: true });
  });

  it('a LEAD document never states a confirmation, whatever the appointment row says', () => {
    const xml = serializeAdf(
      mapLeadToAdf({
        lead,
        department: 'SALES',
        vendorName: 'Jeep of Chicago (synthetic)',
        providerName: 'AMQUR AI',
        vehicle: null,
        appointment: {
          type: 'TEST_DRIVE',
          status: 'CONFIRMED',
          availabilityVerified: true,
          requestedDate: '2026-11-21',
          requestedTime: '15:00',
          scheduledAt: new Date('2026-11-21T21:00:00Z'),
          timezone: 'America/Chicago',
        },
      }),
    );
    expect(xml).not.toMatch(/CONFIRMED by/);
    expect(xml).not.toMatch(/DEMO BOOKING/);
    expect(xml).toContain('booking status is NOT stated in this lead');
    expect(xml).toContain('<prospect status="new">');
  });
});
