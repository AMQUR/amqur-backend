import { StoreHoursService } from './store-hours.service';
import { resolveWhen } from '../common/time/date-phrase';
import { fromZoned, toZoned } from '../common/time/zoned-time';

const TZ = 'America/Chicago';

function profile(
  extra: Partial<Parameters<typeof StoreHoursService.buildProfile>[0]> = {},
) {
  return StoreHoursService.buildProfile({
    id: 'loc1',
    name: 'Test Motors',
    timezone: TZ,
    storeHours: {
      mon: { open: '09:00', close: '19:00' },
      tue: { open: '09:00', close: '19:00' },
      wed: { open: '09:00', close: '19:00' },
      thu: { open: '09:00', close: '19:00' },
      fri: { open: '09:00', close: '19:00' },
      sat: { open: '09:00', close: '18:00' },
      sun: null,
    },
    departmentHours: {
      service: {
        mon: { open: '07:00', close: '18:00' },
        sat: { open: '07:30', close: '14:00' },
      },
    },
    holidayHours: [
      { date: '2026-12-25', closed: true, note: 'Christmas' },
      { date: '2026-12-24', open: '09:00', close: '15:00' },
    ],
    storeHoursVerifiedAt: new Date('2026-10-01T00:00:00Z'),
    ...extra,
  });
}

describe('zoned time (DST-safe)', () => {
  it('converts dealership wall clock to UTC across DST boundaries', () => {
    // CDT (UTC-5)
    expect(
      fromZoned(
        { year: 2026, month: 10, day: 17, hour: 15, minute: 0 },
        TZ,
      ).toISOString(),
    ).toBe('2026-10-17T20:00:00.000Z');
    // CST (UTC-6) after fall-back on 2026-11-01
    expect(
      fromZoned(
        { year: 2026, month: 11, day: 7, hour: 15, minute: 0 },
        TZ,
      ).toISOString(),
    ).toBe('2026-11-07T21:00:00.000Z');
  });

  it('handles the spring-forward gap without throwing and stays on the same date', () => {
    const d = fromZoned(
      { year: 2026, month: 3, day: 8, hour: 2, minute: 30 },
      TZ,
    );
    const back = toZoned(d, TZ);
    expect(back.day).toBe(8);
    expect([1, 3]).toContain(back.hour);
  });

  it('resolves the ambiguous fall-back hour to the earlier instant', () => {
    const d = fromZoned(
      { year: 2026, month: 11, day: 1, hour: 1, minute: 30 },
      TZ,
    );
    expect(d.toISOString()).toBe('2026-11-01T06:30:00.000Z');
  });
});

describe('resolveWhen (dealership-relative)', () => {
  // Tuesday 2026-10-13 23:30 in Chicago == Wednesday 04:30 UTC → must still be Tuesday locally
  const lateTuesday = new Date('2026-10-14T04:30:00Z');

  it('"tomorrow" uses dealership date, not server UTC date', () => {
    const r = resolveWhen('can I come tomorrow?', TZ, lateTuesday)!;
    expect(r.date).toEqual({ year: 2026, month: 10, day: 14 });
  });

  it('"this Saturday at 3" resolves to the coming Saturday 3 PM (inferred meridiem)', () => {
    const r = resolveWhen('I can come this Saturday at 3', TZ, lateTuesday)!;
    expect(r.date).toEqual({ year: 2026, month: 10, day: 17 });
    expect(r.time).toBe(15 * 60);
    expect(r.inferred).toBe(true);
  });

  it('"Friday morning" yields date + part of day without a fabricated time', () => {
    const r = resolveWhen(
      'I need an oil change Friday morning',
      TZ,
      lateTuesday,
    )!;
    expect(r.date).toEqual({ year: 2026, month: 10, day: 16 });
    expect(r.time).toBeUndefined();
    expect(r.partOfDay).toBe('morning');
  });

  it('midnight boundary: "today" right after local midnight', () => {
    const justAfterMidnight = new Date('2026-10-14T05:05:00Z'); // 00:05 CDT Wed
    expect(resolveWhen('today', TZ, justAfterMidnight)!.date).toEqual({
      year: 2026,
      month: 10,
      day: 14,
    });
  });

  it('month/day rolls into next year when already past', () => {
    const r = resolveWhen('jan 5 at 10am', TZ, lateTuesday)!;
    expect(r.date).toEqual({ year: 2027, month: 1, day: 5 });
    expect(r.time).toBe(600);
  });

  it('Spanish weekday + time', () => {
    const r = resolveWhen('el sábado a las 10am', TZ, lateTuesday)!;
    expect(r.date).toEqual({ year: 2026, month: 10, day: 17 });
    expect(r.time).toBe(600);
  });

  it('returns null for text without temporal content', () => {
    expect(
      resolveWhen('what colors does the wrangler come in', TZ, lateTuesday),
    ).toBeNull();
  });
});

describe('StoreHoursService', () => {
  const now = new Date('2026-10-13T15:00:00Z'); // Tue 10:00 CDT

  it('rejects requests when hours are not staff-verified (no hard-coded fallback)', () => {
    const p = profile({ storeHoursVerifiedAt: null });
    expect(p.verified).toBe(false);
    expect(
      StoreHoursService.validateSlot(
        p,
        { year: 2026, month: 10, day: 17 },
        900,
        { now },
      ),
    ).toEqual({
      ok: false,
      code: 'hours_unverified',
    });
    expect(StoreHoursService.summarize(p)).toBeNull();
  });

  it('closed weekly day', () => {
    const v = StoreHoursService.validateSlot(
      profile(),
      { year: 2026, month: 10, day: 18 },
      600,
      { now },
    );
    expect(v.ok).toBe(false);
    expect(!v.ok && v.code).toBe('closed_day');
  });

  it('holiday closure overrides weekly hours', () => {
    const v = StoreHoursService.validateSlot(
      profile(),
      { year: 2026, month: 12, day: 25 },
      600,
      { now },
    );
    expect(!v.ok && v.code).toBe('closed_day');
    expect(!v.ok && v.day?.reason).toBe('holiday');
  });

  it('holiday short hours', () => {
    const v = StoreHoursService.validateSlot(
      profile(),
      { year: 2026, month: 12, day: 24 },
      16 * 60,
      { now },
    );
    expect(!v.ok && v.code).toBe('outside_hours');
  });

  it('department hours (service opens earlier on Saturday, closes at 2)', () => {
    const sat = { year: 2026, month: 10, day: 17 };
    expect(
      StoreHoursService.validateSlot(profile(), sat, 7 * 60 + 45, {
        now,
        department: 'service',
      }).ok,
    ).toBe(true);
    expect(
      StoreHoursService.validateSlot(profile(), sat, 15 * 60, {
        now,
        department: 'service',
      }).ok,
    ).toBe(false);
    expect(
      StoreHoursService.validateSlot(profile(), sat, 15 * 60, {
        now,
        department: 'sales',
      }).ok,
    ).toBe(true);
  });

  it('valid slot returns UTC instant computed in dealership tz', () => {
    const v = StoreHoursService.validateSlot(
      profile(),
      { year: 2026, month: 10, day: 17 },
      15 * 60,
      { now },
    );
    expect(v.ok && v.instant.toISOString()).toBe('2026-10-17T20:00:00.000Z');
  });

  it('rejects past slots', () => {
    const v = StoreHoursService.validateSlot(
      profile(),
      { year: 2026, month: 10, day: 13 },
      9 * 60 + 30,
      { now },
    );
    expect(!v.ok && v.code).toBe('in_past');
  });

  it('open-now and next-open', () => {
    expect(StoreHoursService.isOpenAt(profile(), now).open).toBe(true);
    const sunday = new Date('2026-10-18T17:00:00Z');
    const r = StoreHoursService.isOpenAt(profile(), sunday);
    expect(r.open).toBe(false);
    expect(r.nextOpen).toEqual({ date: '2026-10-19', open: 540 });
  });

  it('summarizes verified hours in English and Spanish', () => {
    expect(StoreHoursService.summarize(profile())).toBe(
      'Mon–Fri 9 AM–7 PM, Sat 9 AM–6 PM, Sun closed',
    );
    expect(StoreHoursService.summarize(profile(), 'store', 'es')).toBe(
      'lun–vie 09:00–19:00, sáb 09:00–18:00, dom cerrado',
    );
  });
});
