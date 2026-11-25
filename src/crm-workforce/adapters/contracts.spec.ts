import {
  bookSlot,
  confirmedAppointmentFact,
  FixtureSlotSource,
  offerableSlots,
  UnavailableSlotSource,
  type BookingRequest,
  type Slot,
  type SlotQuery,
  type VerifiedHours,
} from './appointment-availability.contract';
import {
  orderPage,
  planReply,
  UnavailableReplySource,
  type InboundReply,
} from './reply-detection.contract';

const now = new Date('2026-12-01T15:00:00Z'); // Tue 09:00 America/Chicago
const prov = {
  sourceRecordId: 'fixture',
  asOf: '2026-12-01T14:55:00Z',
  verified: true,
  rooftopId: 'nissan',
};
const slot = (
  id: string,
  startUtc: string,
  extra: Partial<Slot> = {},
): Slot => ({
  ...prov,
  slotId: id,
  department: 'SERVICE',
  start: startUtc,
  end: new Date(Date.parse(startUtc) + 3_600_000).toISOString(),
  ...extra,
});
const hours: VerifiedHours = {
  ...prov,
  timeZone: 'America/Chicago',
  week: [
    null,
    ...Array(5).fill({ open: 7 * 60, close: 18 * 60 }),
    { open: 8 * 60, close: 13 * 60 },
  ],
};
const rules = {
  now,
  maxAgeMinutes: 30,
  leadTimeMinutes: 60,
  hours,
  rooftopId: 'nissan',
  department: 'SERVICE' as const,
};

describe('appointment availability contract', () => {
  it('offers only verified, fresh, future slots inside verified hours for the right rooftop and department', () => {
    const r = offerableSlots(
      {
        status: 'AVAILABLE',
        source: 'fixture',
        slots: [
          slot('ok', '2026-12-01T18:00:00Z'), // 12:00 local
          slot('soon', '2026-12-01T15:30:00Z'), // inside lead time
          slot('late', '2026-12-01T23:30:00Z'), // 17:30 local, ends 18:30 > close
          slot('sunday', '2026-12-06T16:00:00Z'), // closed
          slot('stale', '2026-12-01T19:00:00Z', {
            asOf: '2026-12-01T13:00:00Z',
          }),
          slot('unverified', '2026-12-01T19:00:00Z', { verified: false }),
          slot('other-store', '2026-12-01T19:00:00Z', { rooftopId: 'chevy' }),
          slot('sales', '2026-12-01T19:00:00Z', { department: 'SALES' }),
        ],
      },
      rules,
    );
    expect(r.offer.map((s) => s.slotId)).toEqual(['ok']);
    expect(
      Object.fromEntries(r.rejected.map((x) => [x.slotId, x.why])),
    ).toEqual({
      soon: 'past_or_too_soon',
      late: 'outside_hours',
      sunday: 'outside_hours',
      stale: 'stale',
      unverified: 'unverified',
      'other-store': 'wrong_rooftop',
      sales: 'wrong_department',
    });
    expect(
      offerableSlots(
        {
          status: 'AVAILABLE',
          source: 'f',
          slots: [slot('ok', '2026-12-01T18:00:00Z')],
        },
        { ...rules, hours: null },
      ).offer,
    ).toEqual([]);
  });

  const q: SlotQuery = {
    tenantId: 't',
    locationId: 'l',
    department: 'SERVICE',
    from: '2026-12-01',
    to: '2026-12-02',
  };
  const req = (s: Slot, key = 'k1'): BookingRequest => ({
    idempotencyKey: key,
    tenantId: 't',
    locationId: 'l',
    slot: s,
    crmLeadRef: 'lead-1',
  });

  it('confirms only after a read-back with the source reference, and is idempotent on retry', async () => {
    const s = slot('a', '2026-12-01T18:00:00Z');
    const src = new FixtureSlotSource([s]);
    const r1 = await bookSlot(src, req(s), q);
    expect(r1).toEqual({ status: 'CONFIRMED', externalRef: 'FIX-1' });
    expect(confirmedAppointmentFact(r1, req(s))).toMatchObject({
      kind: 'appointment',
      verified: true,
      sourceRecordId: 'FIX-1',
    });
    expect(await bookSlot(src, req(s), q)).toEqual(r1); // retry: same booking, not a second one
  });

  it('never double-books: a slot taken meanwhile is SLOT_TAKEN', async () => {
    const s = slot('a', '2026-12-01T18:00:00Z');
    const src = new FixtureSlotSource([s]);
    src.take('a');
    expect((await bookSlot(src, req(s), q)).status).toBe('SLOT_TAKEN');
    const src2 = new FixtureSlotSource([s]);
    await bookSlot(src2, req(s, 'first'), q);
    expect((await bookSlot(src2, req(s, 'second'), q)).status).toBe(
      'SLOT_TAKEN',
    );
  });

  it('an unconfirmed or failed call is never reported as booked', async () => {
    const s = slot('a', '2026-12-01T18:00:00Z');
    const r = await bookSlot(
      new FixtureSlotSource([s], { confirm: false }),
      req(s),
      q,
    );
    expect(r.status).toBe('BOOKED_UNVERIFIED');
    expect(confirmedAppointmentFact(r, req(s))).toBeNull();
    expect(
      (
        await bookSlot(
          new FixtureSlotSource([s], { failBook: true }),
          req(s),
          q,
        )
      ).status,
    ).toBe('UNCERTAIN');
  });

  it('production default is BLOCKED and books nothing', async () => {
    const s = slot('a', '2026-12-01T18:00:00Z');
    expect((await new UnavailableSlotSource().lookup()).status).toBe('BLOCKED');
    expect(
      (await bookSlot(new UnavailableSlotSource(), req(s), q)).status,
    ).toBe('BLOCKED');
  });
});

describe('reply detection contract', () => {
  const r = (
    id: string,
    body: string,
    at = '2026-12-01T15:00:00Z',
  ): InboundReply => ({
    sourceMessageId: id,
    crmLeadRef: 'lead-1',
    channel: 'SMS',
    occurredAt: at,
    body,
  });
  const state = {
    seenMessageIds: new Set<string>(),
    openOutboundActionIds: ['draft-1', 'queued-2'],
    agentPaused: false,
  };

  it('any reply cancels unsent outbound; an ordinary reply makes the customer P0', () => {
    expect(planReply(r('m1', 'Saturday works for me'), state)).toMatchObject({
      kind: 'customer_waiting',
      cancelActionIds: ['draft-1', 'queued-2'],
      priority: 0,
    });
  });
  it('opt-out suppresses the channel; Spanish too', () => {
    expect(planReply(r('m1', 'STOP'), state)).toMatchObject({
      kind: 'opt_out',
      suppressChannel: 'SMS',
      cancelActionIds: ['draft-1', 'queued-2'],
    });
    expect(planReply(r('m2', 'No me escriban más'), state).kind).toBe(
      'opt_out',
    );
  });
  it('needs-a-person replies escalate with urgency', () => {
    expect(
      planReply(r('m1', 'My brakes failed after your service'), state),
    ).toMatchObject({
      kind: 'escalate',
      escalation: { reason: 'SAFETY', urgency: 'CRITICAL' },
    });
  });
  it('a person already handling the lead keeps it: no agent queueing', () => {
    expect(
      planReply(r('m1', 'ok thanks'), { ...state, agentPaused: true }),
    ).toMatchObject({
      kind: 'customer_waiting',
      priority: null,
      humanOwned: true,
    });
  });
  it('the same reply seen twice is handled once; pages are ordered and de-duplicated', () => {
    expect(
      planReply(r('m1', 'hello'), {
        ...state,
        seenMessageIds: new Set(['m1']),
      }),
    ).toEqual({ kind: 'duplicate' });
    const p = orderPage({
      status: 'OK',
      nextCursor: 'c2',
      replies: [
        r('b', 'x', '2026-12-01T16:00:00Z'),
        r('a', 'y', '2026-12-01T15:00:00Z'),
        r('b', 'x', '2026-12-01T16:00:00Z'),
      ],
    });
    expect(p.replies.map((x) => x.sourceMessageId)).toEqual(['a', 'b']);
    expect(p.commitCursor).toBe('c2');
  });
  it('production default is BLOCKED and moves no cursor', async () => {
    const page = await new UnavailableReplySource().poll();
    expect(page.status).toBe('BLOCKED');
    expect(orderPage(page)).toEqual({ replies: [], commitCursor: null });
  });
});
