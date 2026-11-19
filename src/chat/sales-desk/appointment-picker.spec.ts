import { StoreHoursService } from '../../locations/store-hours.service';
import {
  buildPicker,
  rememberPicker,
  requestOnlyDays,
  resolveSelection,
  SLOT_OFFER_TTL_MS,
  usableProviderSlots,
} from './appointment-picker';
import type { SalesDeskState } from './sales-desk.types';

const TZ = 'America/Chicago';
// Tuesday 2026-10-13 10:00 in Chicago
const now = new Date('2026-10-13T15:00:00.000Z');
const week = { open: '09:00', close: '19:00' };
const hours = StoreHoursService.buildProfile({
  id: 'loc',
  name: 'Fixture',
  timezone: TZ,
  storeHours: {
    mon: week,
    tue: week,
    wed: week,
    thu: week,
    fri: week,
    sat: week,
    sun: null,
  },
  departmentHours: null,
  holidayHours: null,
  storeHoursVerifiedAt: new Date('2026-10-01T00:00:00Z'),
  storeHoursVerifiedBy: 'fixture',
} as never);

const slot = (iso: string) => ({
  startUtc: iso,
  endUtc: new Date(Date.parse(iso) + 45 * 60_000).toISOString(),
  providerSlotId: `p:${iso}`,
});

describe('requestOnlyDays', () => {
  it('offers plain calendar days from tomorrow (store timezone) when hours are unknown', () => {
    expect(requestOnlyDays({ now, timezone: TZ, department: 'sales' })).toEqual(
      ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'],
    );
    // 03:00 UTC on the 14th is still the 13th in Chicago → tomorrow is the 14th
    expect(
      requestOnlyDays({
        now: new Date('2026-10-14T03:00:00.000Z'),
        timezone: TZ,
        department: 'sales',
        count: 1,
      }),
    ).toEqual(['2026-10-14']);
  });

  it('skips closed days only when hours are verified', () => {
    expect(hours.verified).toBe(true);
    expect(
      requestOnlyDays({ now, timezone: TZ, hours, department: 'sales' }),
    ).toEqual([
      '2026-10-14',
      '2026-10-15',
      '2026-10-16',
      '2026-10-17',
      '2026-10-19',
    ]);
    expect(
      requestOnlyDays({
        now,
        timezone: TZ,
        hours: { ...hours, verified: false },
        department: 'sales',
      }),
    ).toContain('2026-10-18');
  });

  it('starts at the day the customer already named, never in the past', () => {
    expect(
      requestOnlyDays({
        now,
        timezone: TZ,
        department: 'sales',
        startFrom: { year: 2026, month: 10, day: 16 },
        count: 2,
      }),
    ).toEqual(['2026-10-16', '2026-10-17']);
    expect(
      requestOnlyDays({
        now,
        timezone: TZ,
        department: 'sales',
        startFrom: { year: 2026, month: 10, day: 1 },
        count: 1,
      }),
    ).toEqual(['2026-10-14']);
  });
});

describe('usableProviderSlots', () => {
  it('drops past slots and, with verified hours, slots outside them', () => {
    const slots = [
      slot('2026-10-13T14:00:00.000Z'), // past
      slot('2026-10-14T15:00:00.000Z'), // Wed 10:00
      slot('2026-10-14T12:00:00.000Z'), // Wed 07:00 — before opening
      slot('2026-10-18T17:00:00.000Z'), // Sunday — closed
    ];
    expect(
      usableProviderSlots({
        slots,
        now,
        timezone: TZ,
        hours,
        department: 'sales',
      }).map((s) => s.startUtc),
    ).toEqual(['2026-10-14T15:00:00.000Z']);
    expect(
      usableProviderSlots({ slots, now, timezone: TZ, department: 'sales' }),
    ).toHaveLength(3);
  });
});

describe('buildPicker + resolveSelection', () => {
  const base = {
    type: 'TEST_DRIVE' as const,
    lang: 'en' as const,
    rooftopName: 'Fixture Motors',
    timezone: TZ,
    locationId: 'loc-1',
    vehicleLabel: '2024 Jeep Wrangler',
    vin: '1C4HJXDG0RW100001',
    now,
    days: ['2026-10-14', '2026-10-15'],
  };

  it('request_only by default: days, no slots, no sandbox, no external URL', () => {
    const { card, offered } = buildPicker(base);
    expect(card).toMatchObject({
      kind: 'appointment_picker',
      mode: 'request_only',
      department: 'sales',
      purpose: 'Test drive',
      rooftopName: 'Fixture Motors',
      timezone: TZ,
      days: base.days,
    });
    expect(card).not.toHaveProperty('slots');
    expect(card).not.toHaveProperty('sandbox');
    expect(card).not.toHaveProperty('externalUrl');
    expect(offered).toMatchObject({
      id: card.id,
      mode: 'request_only',
      locationId: 'loc-1',
    });
  });

  it('provider_slots only with provider slots; ids are opaque and the provider id stays server-side', () => {
    const { card, offered } = buildPicker({
      ...base,
      lang: 'es',
      type: 'SERVICE',
      serviceNeed: 'cambio de aceite',
      provider: {
        connectionId: 'conn-1',
        provider: 'MOCK',
        sandbox: true,
        slots: [slot('2026-10-14T15:00:00.000Z')],
      },
    });
    expect(card).toMatchObject({
      mode: 'provider_slots',
      sandbox: true,
      department: 'service',
      purpose: 'cambio de aceite',
      vin: null, // the shopper's sales vehicle is not the car being serviced
    });
    expect(card.slots).toEqual([
      {
        id: expect.stringMatching(/^sl_/),
        start: '2026-10-14T15:00:00.000Z',
        end: '2026-10-14T15:45:00.000Z',
        expiresAt: new Date(now.getTime() + SLOT_OFFER_TTL_MS).toISOString(),
      },
    ]);
    expect(JSON.stringify(card)).not.toContain('p:2026');
    expect(JSON.stringify(card)).not.toContain('conn-1');
    expect(offered.slots![0].providerSlotId).toBe('p:2026-10-14T15:00:00.000Z');
    // an empty provider list falls back to a request
    expect(
      buildPicker({
        ...base,
        provider: {
          connectionId: 'c',
          provider: 'MOCK',
          sandbox: true,
          slots: [],
        },
      }).card.mode,
    ).toBe('request_only');
  });

  const request = buildPicker(base).offered;
  const slots = buildPicker({
    ...base,
    provider: {
      connectionId: 'conn-1',
      provider: 'MOCK',
      sandbox: true,
      slots: [slot('2026-10-14T15:00:00.000Z')],
    },
  }).offered;
  const state: SalesDeskState = { pickers: [request, slots] };
  const sel = (
    selection: Parameters<typeof resolveSelection>[0]['selection'],
    over = {},
  ) =>
    resolveSelection({
      selection,
      state,
      locationId: 'loc-1',
      timezone: TZ,
      now,
      ...over,
    });

  it('resolves an offered day + window', () => {
    expect(
      sel({
        pickerId: request.id,
        requestedDate: '2026-10-15',
        requestedWindow: 'evening',
      }),
    ).toMatchObject({
      ok: true,
      kind: 'request',
      date: { year: 2026, month: 10, day: 15 },
      window: 'evening',
    });
  });

  it('resolves an offered slot to its store-local date and time', () => {
    expect(
      sel({ pickerId: slots.id, slotId: slots.slots![0].id }),
    ).toMatchObject({
      ok: true,
      kind: 'slot',
      date: { year: 2026, month: 10, day: 14 },
      time: 10 * 60,
    });
  });

  it.each([
    [
      'unknown_picker',
      { pickerId: 'pk_never_issued_here', slotId: 'sl_x' },
      {},
    ],
    [
      'unknown_slot',
      { pickerId: slots.id, slotId: 'sl_forged_slot_id_01' },
      {},
    ],
    ['unknown_slot', { pickerId: slots.id, slotId: request.id }, {}],
    [
      'invalid_selection',
      { pickerId: request.id, slotId: slots.slots![0].id },
      {},
    ],
    [
      'invalid_selection',
      {
        pickerId: slots.id,
        requestedDate: '2026-10-14',
        requestedWindow: 'morning',
      },
      {},
    ],
    ['invalid_selection', { pickerId: request.id }, {}],
    [
      'invalid_selection',
      { pickerId: request.id, requestedDate: '2026-10-14' },
      {},
    ],
    [
      'invalid_selection',
      {
        pickerId: request.id,
        requestedDate: '2026-10-14',
        requestedWindow: 'noon',
      },
      {},
    ],
    [
      'day_not_offered',
      {
        pickerId: request.id,
        requestedDate: '2026-12-25',
        requestedWindow: 'morning',
      },
      {},
    ],
    [
      'day_not_offered', // the offered day is over in the store timezone
      {
        pickerId: request.id,
        requestedDate: '2026-10-14',
        requestedWindow: 'morning',
      },
      { now: new Date('2026-10-15T06:00:00.000Z') },
    ],
    [
      'slot_expired',
      { pickerId: slots.id, slotId: slots.slots![0].id },
      { now: new Date(now.getTime() + SLOT_OFFER_TTL_MS) },
    ],
    [
      'wrong_location',
      { pickerId: slots.id, slotId: slots.slots![0].id },
      { locationId: 'loc-2' },
    ],
    [
      'unknown_picker', // another conversation/tenant has no such picker in its state
      { pickerId: slots.id, slotId: slots.slots![0].id },
      { state: { pickers: [] } },
    ],
    [
      'unknown_picker',
      { pickerId: slots.id, slotId: slots.slots![0].id },
      { state: undefined },
    ],
  ] as Array<
    [string, Parameters<typeof resolveSelection>[0]['selection'], object]
  >)('refuses with %s', (reason, selection, over) => {
    expect(sel(selection, over)).toMatchObject({ ok: false, reason });
  });

  it('remembers only the most recent pickers', () => {
    let st: SalesDeskState | undefined;
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const { offered } = buildPicker(base);
      ids.push(offered.id);
      st = rememberPicker(st, offered);
    }
    expect(st!.pickers!.map((p) => p.id)).toEqual(ids.slice(-3));
  });
});
