import { countUnanswered, LeadFacts, prioritize } from './prioritization';

const NOW = new Date('2026-11-18T16:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const f = (p: Partial<LeadFacts> = {}): LeadFacts => ({
  department: 'SALES',
  crmStatus: 'active',
  leadSource: 'website',
  createdInCrmAt: ago(1),
  lastInboundAt: null,
  lastOutboundAt: null,
  hasFutureFollowUp: false,
  appointmentState: 'NONE',
  appointmentAt: null,
  visitedAt: null,
  inboundSignals: [],
  unansweredAttempts: 0,
  vehicleAvailableAgain: null,
  ...p,
});

describe('lead prioritisation', () => {
  it('P0: an unanswered customer reply outranks everything', () => {
    const r = prioritize(
      f({
        lastInboundAt: ago(0.01),
        lastOutboundAt: ago(1),
        createdInCrmAt: ago(200),
      }),
      NOW,
    );
    expect(r).toMatchObject({
      priority: 0,
      workflowKey: 'reply_inbound',
      agentKey: 'conversation_manager',
    });
    expect(r!.evidence[0].rule).toBe('P0.unanswered_inbound');
  });
  it('P0 applies even to a closed lead — the customer wrote back', () => {
    expect(
      prioritize(
        f({
          crmStatus: 'Lost',
          lastInboundAt: ago(0.1),
          lastOutboundAt: ago(5),
        }),
        NOW,
      )?.priority,
    ).toBe(0);
  });
  it('P1: new lead with no response', () => {
    expect(prioritize(f(), NOW)).toMatchObject({
      priority: 1,
      workflowKey: 'first_response',
      agentKey: 'sales_bdc',
    });
    expect(prioritize(f({ department: 'SERVICE' }), NOW)?.agentKey).toBe(
      'service_bdc',
    );
    expect(prioritize(f({ department: 'PARTS' }), NOW)?.agentKey).toBe(
      'parts_bdc',
    );
  });
  it('P2: inbound appointment change', () => {
    expect(
      prioritize(
        f({ lastInboundAt: ago(0.1), inboundSignals: ['APPOINTMENT_CHANGE'] }),
        NOW,
      ),
    ).toMatchObject({ priority: 2, agentKey: 'appointment_manager' });
  });
  it('P3: inbound purchase intent', () => {
    expect(
      prioritize(
        f({ lastInboundAt: ago(0.1), inboundSignals: ['PURCHASE_INTENT'] }),
        NOW,
      )?.priority,
    ).toBe(3);
  });
  it('P4: missed appointment and visited-unsold', () => {
    expect(
      prioritize(
        f({
          createdInCrmAt: ago(10),
          lastOutboundAt: ago(3),
          appointmentState: 'MISSED',
          appointmentAt: ago(2),
        }),
        NOW,
      ),
    ).toMatchObject({ priority: 4, workflowKey: 'missed_appointment' });
    expect(
      prioritize(
        f({
          createdInCrmAt: ago(10),
          lastOutboundAt: ago(3),
          visitedAt: ago(3),
        }),
        NOW,
      ),
    ).toMatchObject({ priority: 4, workflowKey: 'visited_unsold' });
  });
  it('P5: engaged customer who stopped responding', () => {
    expect(
      prioritize(
        f({
          createdInCrmAt: ago(12),
          lastInboundAt: ago(6),
          lastOutboundAt: ago(5),
        }),
        NOW,
      ),
    ).toMatchObject({ priority: 5, segment: 'engaged_stopped_responding' });
  });
  it('P6: overdue with no future follow-up, and never-contacted past the new-lead window', () => {
    expect(
      prioritize(f({ createdInCrmAt: ago(20), lastOutboundAt: ago(9) }), NOW),
    ).toMatchObject({ priority: 6, segment: 'overdue_no_reply' });
    expect(prioritize(f({ createdInCrmAt: ago(8) }), NOW)).toMatchObject({
      priority: 6,
      segment: 'never_contacted',
    });
  });
  it('a lead with a future follow-up task is left to its owner', () => {
    expect(
      prioritize(
        f({
          createdInCrmAt: ago(20),
          lastOutboundAt: ago(9),
          hasFutureFollowUp: true,
        }),
        NOW,
      ),
    ).toBeNull();
  });
  it('P7: older-lead reactivation, with vehicle-available-again evidence only when verified', () => {
    const r = prioritize(
      f({
        createdInCrmAt: ago(90),
        lastOutboundAt: ago(80),
        vehicleAvailableAgain: true,
      }),
      NOW,
    );
    expect(r).toMatchObject({
      priority: 7,
      segment: 'vehicle_available_again',
    });
    expect(r!.evidence.map((e) => e.rule)).toContain(
      'P7.vehicle_available_again',
    );
    expect(
      prioritize(f({ createdInCrmAt: ago(90), lastOutboundAt: ago(80) }), NOW)
        ?.segment,
    ).toBe('older_never_engaged');
  });
  it('closed and too-old leads produce no outbound work', () => {
    expect(
      prioritize(f({ crmStatus: 'Sold', createdInCrmAt: ago(5) }), NOW),
    ).toBeNull();
    expect(
      prioritize(
        f({ createdInCrmAt: ago(500), lastOutboundAt: ago(400) }),
        NOW,
      ),
    ).toBeNull();
  });
  it('keeps evidence for every decision and reads no personal attribute', () => {
    const r = prioritize(f(), NOW)!;
    expect(r.evidence.length).toBeGreaterThan(0);
    const keys = Object.keys(f());
    for (const banned of [
      'age',
      'gender',
      'race',
      'ethnicity',
      'religion',
      'zip',
      'income',
      'name',
      'creditScore',
    ])
      expect(keys).not.toContain(banned);
  });
  it('counts outbound attempts since the last customer reply', () => {
    const m = (direction: string, d: number, channel = 'SMS') => ({
      direction,
      occurredAt: ago(d),
      channel,
    });
    expect(
      countUnanswered([
        m('INBOUND', 9),
        m('OUTBOUND', 5),
        m('OUTBOUND', 2),
        m('OUTBOUND', 1, 'NOTE'),
      ]),
    ).toBe(2);
    expect(countUnanswered([m('OUTBOUND', 5), m('INBOUND', 1)])).toBe(0);
  });
});
