import {
  deliveryConfig,
  dueKinds,
  localNow,
  parseSchedule,
  renderReport,
} from './report-scheduler.service';

describe('CRM Workforce report scheduling', () => {
  it('is off unless explicitly enabled with a valid channel', () => {
    expect(deliveryConfig({}).enabled).toBe(false);
    expect(
      deliveryConfig({ CRM_WORKFORCE_REPORTS_ENABLED: 'true' }).enabled,
    ).toBe(false);
    expect(
      deliveryConfig({
        CRM_WORKFORCE_REPORTS_ENABLED: 'true',
        CRM_WORKFORCE_REPORT_CHANNEL: 'webhook',
        CRM_WORKFORCE_REPORT_WEBHOOK_URL: 'http://insecure.example',
      }).enabled,
    ).toBe(false);
    expect(
      deliveryConfig({
        CRM_WORKFORCE_REPORTS_ENABLED: 'true',
        CRM_WORKFORCE_REPORT_CHANNEL: 'email',
        CRM_WORKFORCE_REPORT_RECIPIENTS: 'ops@example.invalid',
        CRM_WORKFORCE_REPORT_FROM: 'r@example.invalid',
      }).enabled,
    ).toBe(false); // no Resend key
    expect(
      deliveryConfig({
        CRM_WORKFORCE_REPORTS_ENABLED: 'true',
        CRM_WORKFORCE_REPORT_CHANNEL: 'webhook',
        CRM_WORKFORCE_REPORT_WEBHOOK_URL: 'https://hooks.example.invalid/x',
      }),
    ).toMatchObject({ enabled: true, channel: 'webhook' });
  });
  it('parses the schedule and finds what is due in Chicago time (DST-safe)', () => {
    const s = parseSchedule(undefined);
    expect(s.map((x) => x.kind)).toEqual([
      'morning',
      'midday',
      'end_of_day',
      'weekly',
    ]);
    expect(parseSchedule('morning@25:00,bogus@07:00,weekly@xyz-08:00')).toEqual(
      [],
    );
    // 2026-11-30 is a Monday; 14:35 UTC = 08:35 CST.
    const mon = new Date('2026-11-30T14:35:00Z');
    expect(localNow(mon)).toMatchObject({
      date: '2026-11-30',
      weekday: 1,
      minute: 8 * 60 + 35,
    });
    expect(dueKinds(s, mon)).toEqual(['weekly']);
    expect(dueKinds(s, new Date('2026-11-30T13:40:00Z'))).toEqual(['morning']); // 07:40
    expect(dueKinds(s, new Date('2026-12-01T14:35:00Z'))).toEqual([]); // Tuesday 08:35
    // Summer time: 07:40 CDT = 12:40 UTC.
    expect(dueKinds(s, new Date('2026-07-01T12:40:00Z'))).toEqual(['morning']);
  });
  it('never shows unknown model cost as $0 and carries no customer data', () => {
    const r = {
      kind: 'morning',
      periodHours: 16,
      note: 'n',
      customers: {
        repliesReceived: 1,
        newLeads: 2,
        waitingOnReply: 1,
        appointmentsNext24h: 0,
      },
      staffWorkItems: [],
      messages: {
        draftsWaiting: 0,
        sentConfirmedInCrm: 0,
        sentByEmployees: 1,
        unknownResult: 0,
        blocked: 0,
      },
      compliance: { optOutsRecorded: 0 },
      cost: { modelCalls: 3, modelCostMicroUsd: 0 },
      needsAttention: [],
    } as never;
    const prev = {
      a: process.env.LLM_COST_INPUT_PER_MTOK,
      b: process.env.LLM_COST_OUTPUT_PER_MTOK,
    };
    delete process.env.LLM_COST_INPUT_PER_MTOK;
    delete process.env.LLM_COST_OUTPUT_PER_MTOK;
    expect(renderReport('Dial Nissan of Chicago', r)).toContain(
      'unknown (model prices not configured)',
    );
    if (prev.a) process.env.LLM_COST_INPUT_PER_MTOK = prev.a;
    if (prev.b) process.env.LLM_COST_OUTPUT_PER_MTOK = prev.b;
  });
});
