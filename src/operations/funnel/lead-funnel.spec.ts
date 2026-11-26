import {
  buildLeadFunnel,
  clampWindowDays,
  FUNNEL_STAGES,
  FunnelCounts,
} from './lead-funnel';

const base: FunnelCounts = {
  leads: 20,
  deliveriesQueued: 18,
  deliveriesAccepted: 10,
  deliveriesAcceptedSandbox: 5,
  deliveriesCrmReceived: 4,
  deliveriesCrmMatched: 3,
  deliveriesCrmRejected: 1,
  deliveriesBlocked: 2,
  deliveriesFailedOrDead: 1,
  appointments: 9,
  appointmentsProviderConfirmed: 2,
  appointmentsSandboxConfirmed: 4,
  appointmentsStaffConfirmed: 1,
};
const since = new Date('2026-11-12T00:00:00Z');
const stage = (f: ReturnType<typeof buildLeadFunnel>, s: string) =>
  f.stages.find((r) => r.stage === s)!.count;

describe('lead and appointment funnel', () => {
  it('uses exactly the fixed vocabulary, in order', () => {
    expect(buildLeadFunnel(base, 7, since).stages.map((s) => s.stage)).toEqual([
      ...FUNNEL_STAGES,
    ]);
    expect(FUNNEL_STAGES).toEqual([
      'LEAD_CREATED',
      'LEAD_QUEUED',
      'MAIL_ACCEPTED',
      'CRM_RECEIVED',
      'CRM_MATCHED',
      'APPOINTMENT_REQUESTED',
      'APPOINTMENT_CONFIRMED',
    ]);
  });

  it('never counts mail acceptance as CRM ingestion', () => {
    const f = buildLeadFunnel(base, 7, since);
    expect(stage(f, 'MAIL_ACCEPTED')).toBe(10);
    expect(stage(f, 'CRM_RECEIVED')).toBe(4);
    expect(stage(f, 'CRM_MATCHED')).toBe(3);
    expect(f.needsAttention.acceptedNotConfirmedInCrm).toBe(6);
    expect(f.stages.find((s) => s.stage === 'MAIL_ACCEPTED')!.evidence).toMatch(
      /not delivery and not a CRM lead/,
    );
  });

  it('keeps sandbox acknowledgements out of every proven stage', () => {
    const f = buildLeadFunnel(base, 7, since);
    expect(stage(f, 'MAIL_ACCEPTED')).toBe(10); // the 5 sandbox ones are not added
    expect(f.notProven.mailAcceptedSandboxOnly).toBe(5);
    expect(stage(f, 'APPOINTMENT_CONFIRMED')).toBe(2);
    expect(f.notProven.appointmentsSandboxConfirmed).toBe(4);
  });

  it('counts a confirmation only with a provider receipt; staff-only is separate', () => {
    const f = buildLeadFunnel(base, 7, since);
    expect(stage(f, 'APPOINTMENT_REQUESTED')).toBe(9);
    expect(stage(f, 'APPOINTMENT_CONFIRMED')).toBe(2);
    expect(f.notProven.appointmentsStaffConfirmedNoReceipt).toBe(1);
  });

  it('cannot show a later stage larger than the evidence before it', () => {
    const f = buildLeadFunnel(
      {
        ...base,
        deliveriesAccepted: 2,
        deliveriesCrmReceived: 9,
        deliveriesCrmMatched: 9,
      },
      7,
      since,
    );
    expect(stage(f, 'CRM_RECEIVED')).toBe(2);
    expect(stage(f, 'CRM_MATCHED')).toBe(2);
  });

  it('surfaces what staff must chase', () => {
    expect(buildLeadFunnel(base, 7, since).needsAttention).toEqual({
      crmRejected: 1,
      blocked: 2,
      failedOrDead: 1,
      acceptedNotConfirmedInCrm: 6,
    });
  });

  it('treats bad numbers as zero and clamps the window', () => {
    const f = buildLeadFunnel(
      { ...base, leads: -3, appointments: Number.NaN },
      7,
      since,
    );
    expect(stage(f, 'LEAD_CREATED')).toBe(0);
    expect(stage(f, 'APPOINTMENT_REQUESTED')).toBe(0);
    expect(clampWindowDays('30')).toBe(30);
    expect(clampWindowDays('0')).toBe(1);
    expect(clampWindowDays('9999')).toBe(90);
    expect(clampWindowDays('abc')).toBe(7);
  });
});
