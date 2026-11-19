import {
  addDays,
  fromZoned,
  isoDate,
  LocalDate,
  parseIsoDate,
  toZoned,
} from '../../common/time/zoned-time';
import {
  Department,
  HoursProfile,
  StoreHoursService,
} from '../../locations/store-hours.service';
import type { AvailabilitySlot } from '../../appointments/scheduling-provider';
import { newCardId } from './lead-form';
import type {
  AppointmentPickerCard,
  AppointmentWindow,
  OfferedPicker,
  PickerAppointmentType,
  PickerDepartment,
  SalesDeskLang,
  SalesDeskState,
} from './sales-desk.types';

export const PICKER_DAY_COUNT = 5;
export const PICKER_MAX_SLOTS = 12;
/** How long an offered provider slot stays selectable. */
export const SLOT_OFFER_TTL_MS = 15 * 60_000;
export const PICKERS_REMEMBERED = 3;
export const WINDOWS: AppointmentWindow[] = ['morning', 'afternoon', 'evening'];

export function pickerDepartment(
  type: PickerAppointmentType,
): PickerDepartment {
  return type === 'SERVICE' ? 'service' : 'sales';
}

export function departmentLabel(d: PickerDepartment, lang: SalesDeskLang) {
  const es = lang === 'es';
  return d === 'service'
    ? es
      ? 'Servicio'
      : 'Service'
    : d === 'parts'
      ? es
        ? 'Refacciones'
        : 'Parts'
      : es
        ? 'Ventas'
        : 'Sales';
}

export function pickerPurpose(
  type: PickerAppointmentType,
  lang: SalesDeskLang,
  serviceNeed?: string | null,
) {
  const es = lang === 'es';
  if (type === 'SERVICE')
    return serviceNeed?.trim()
      ? serviceNeed.trim().slice(0, 80)
      : es
        ? 'Cita de servicio'
        : 'Service visit';
  if (type === 'TEST_DRIVE') return es ? 'Prueba de manejo' : 'Test drive';
  return es ? 'Visita' : 'Visit';
}

/**
 * Calendar days offered in request-only mode, in the STORE timezone, starting tomorrow (or at
 * `startFrom` when the customer already named a day). With verified hours only open days are
 * offered; without them plain calendar days are offered and no business hours are implied.
 */
export function requestOnlyDays(p: {
  now: Date;
  timezone: string;
  hours?: HoursProfile | null;
  department: Department;
  startFrom?: LocalDate | null;
  count?: number;
}): string[] {
  const count = p.count ?? PICKER_DAY_COUNT;
  const z = toZoned(p.now, p.timezone);
  const tomorrow = addDays({ year: z.year, month: z.month, day: z.day }, 1);
  const start =
    p.startFrom && isoDate(p.startFrom) >= isoDate(tomorrow)
      ? p.startFrom
      : tomorrow;
  const out: string[] = [];
  for (let i = 0; i <= 28 && out.length < count; i += 1) {
    const d = addDays(start, i);
    if (p.hours?.verified) {
      const day = StoreHoursService.resolveDay(p.hours, d, p.department);
      if (day.closed) continue;
    }
    out.push(isoDate(d));
  }
  return out;
}

/** Provider slots that are in the future and (when hours are verified) inside store hours. */
export function usableProviderSlots(p: {
  slots: AvailabilitySlot[];
  now: Date;
  timezone: string;
  hours?: HoursProfile | null;
  department: Department;
  max?: number;
}): AvailabilitySlot[] {
  const out: AvailabilitySlot[] = [];
  const sorted = [...p.slots].sort((a, b) =>
    a.startUtc.localeCompare(b.startUtc),
  );
  for (const s of sorted) {
    const start = new Date(s.startUtc);
    if (Number.isNaN(start.getTime()) || start.getTime() <= p.now.getTime())
      continue;
    if (p.hours?.verified) {
      const z = toZoned(start, p.timezone);
      const v = StoreHoursService.validateSlot(
        p.hours,
        { year: z.year, month: z.month, day: z.day },
        z.hour * 60 + z.minute,
        { department: p.department, now: p.now },
      );
      if (!v.ok && v.code !== 'hours_unverified') continue;
    }
    out.push(s);
    if (out.length >= (p.max ?? PICKER_MAX_SLOTS)) break;
  }
  return out;
}

export function buildPicker(p: {
  type: PickerAppointmentType;
  lang: SalesDeskLang;
  rooftopName: string;
  timezone: string;
  locationId: string | null;
  vehicleLabel?: string | null;
  vin?: string | null;
  serviceNeed?: string | null;
  now: Date;
  /** Request-only days (always supplied as the fallback). */
  days: string[];
  /** When present and non-empty the picker offers real provider slots. */
  provider?: {
    connectionId: string;
    provider: string;
    sandbox: boolean;
    slots: AvailabilitySlot[];
  };
}): { card: AppointmentPickerCard; offered: OfferedPicker } {
  const id = newCardId('pk');
  const department = pickerDepartment(p.type);
  const base = {
    kind: 'appointment_picker' as const,
    id,
    department,
    purpose: pickerPurpose(p.type, p.lang, p.serviceNeed),
    rooftopName: p.rooftopName,
    timezone: p.timezone,
    serverNow: p.now.toISOString(),
    vehicleLabel: p.type === 'SERVICE' ? null : (p.vehicleLabel ?? null),
    vin: p.type === 'SERVICE' ? null : (p.vin ?? null),
  };
  const issuedAt = p.now.toISOString();
  if (p.provider?.slots.length) {
    const expiresAt = new Date(
      p.now.getTime() + SLOT_OFFER_TTL_MS,
    ).toISOString();
    const slots = p.provider.slots.map((s) => ({
      id: newCardId('sl'),
      startUtc: new Date(s.startUtc).toISOString(),
      endUtc: s.endUtc ? new Date(s.endUtc).toISOString() : null,
      expiresAt,
      providerSlotId: s.providerSlotId,
    }));
    return {
      card: {
        ...base,
        mode: 'provider_slots',
        slots: slots.map((s) => ({
          id: s.id,
          start: s.startUtc,
          end: s.endUtc,
          expiresAt: s.expiresAt,
        })),
        ...(p.provider.sandbox ? { sandbox: true } : {}),
      },
      offered: {
        id,
        type: p.type,
        mode: 'provider_slots',
        locationId: p.locationId,
        issuedAt,
        connectionId: p.provider.connectionId,
        provider: p.provider.provider,
        slots,
      },
    };
  }
  return {
    card: { ...base, mode: 'request_only', days: p.days },
    offered: {
      id,
      type: p.type,
      mode: 'request_only',
      locationId: p.locationId,
      issuedAt,
      days: p.days,
    },
  };
}

export function rememberPicker(
  state: SalesDeskState | undefined,
  offered: OfferedPicker,
): SalesDeskState {
  return {
    ...state,
    pickers: [...(state?.pickers ?? []), offered].slice(-PICKERS_REMEMBERED),
  };
}

/** SALES and TEST_DRIVE are one visit to the showroom; SERVICE is its own. */
export function bookingFamily(type: string): 'service' | 'sales' {
  return type === 'SERVICE' ? 'service' : 'sales';
}

/**
 * A booking was saved: every provider-slot picker of the same kind is spent. The picker the
 * booking came from keeps only the booked slot (so re-submitting it stays an idempotent replay);
 * no other remembered slot can ever book a second appointment.
 */
export function settlePickersAfterBooking(
  state: SalesDeskState | undefined,
  booked: { pickerId: string; slotId: string; type: string },
): SalesDeskState {
  return {
    ...state,
    pickers: (state?.pickers ?? []).map((p) => {
      if (
        p.mode !== 'provider_slots' ||
        bookingFamily(p.type) !== bookingFamily(booked.type)
      )
        return p;
      const mine = p.id === booked.pickerId;
      return {
        ...p,
        settled: true,
        ...(mine ? { bookedSlotId: booked.slotId } : {}),
        slots: mine
          ? (p.slots ?? []).filter((x) => x.id === booked.slotId)
          : [],
      };
    }),
  };
}

export type SelectionRefusal =
  | 'already_booked'
  | 'unknown_picker'
  | 'wrong_location'
  | 'invalid_selection'
  | 'unknown_slot'
  | 'slot_expired'
  | 'day_not_offered';

export type ResolvedSelection =
  | {
      ok: true;
      kind: 'request';
      picker: OfferedPicker;
      date: LocalDate;
      window: AppointmentWindow;
    }
  | {
      ok: true;
      kind: 'slot';
      picker: OfferedPicker;
      slot: NonNullable<OfferedPicker['slots']>[number];
      /** Store-local date and minutes after midnight of the slot start. */
      date: LocalDate;
      time: number;
    }
  | { ok: false; reason: SelectionRefusal; type?: PickerAppointmentType };

/**
 * Resolves a client selection against what THIS conversation was actually offered. A picker
 * or slot id that was never issued here (forged, another conversation's, another tenant's), a
 * slot past its offer window, or a picker issued for a different rooftop is refused.
 */
export function resolveSelection(p: {
  selection: {
    pickerId: string;
    slotId?: string;
    requestedDate?: string;
    requestedWindow?: string;
  };
  state: SalesDeskState | undefined;
  locationId: string | null;
  timezone: string;
  now: Date;
}): ResolvedSelection {
  const picker = (p.state?.pickers ?? []).find(
    (x) => x.id === p.selection.pickerId,
  );
  if (!picker) return { ok: false, reason: 'unknown_picker' };
  if ((picker.locationId ?? null) !== (p.locationId ?? null))
    return { ok: false, reason: 'wrong_location', type: picker.type };
  const { slotId, requestedDate, requestedWindow } = p.selection;
  const fail = (reason: SelectionRefusal): ResolvedSelection => ({
    ok: false,
    reason,
    type: picker.type,
  });

  if (slotId) {
    if (requestedDate || requestedWindow || picker.mode !== 'provider_slots')
      return fail('invalid_selection');
    // A spent card can only replay the booking it produced — never book another slot.
    if (picker.settled && slotId !== picker.bookedSlotId)
      return fail('already_booked');
    const slot = (picker.slots ?? []).find((s) => s.id === slotId);
    if (!slot) return fail('unknown_slot');
    if (
      // The booked slot of a spent card replays the saved booking; its offer window is moot.
      !picker.settled &&
      (Date.parse(slot.expiresAt) <= p.now.getTime() ||
        Date.parse(slot.startUtc) <= p.now.getTime())
    )
      return fail('slot_expired');
    const z = toZoned(new Date(slot.startUtc), p.timezone);
    return {
      ok: true,
      kind: 'slot',
      picker,
      slot,
      date: { year: z.year, month: z.month, day: z.day },
      time: z.hour * 60 + z.minute,
    };
  }

  const date = requestedDate ? parseIsoDate(requestedDate) : null;
  if (
    !date ||
    !requestedWindow ||
    !WINDOWS.includes(requestedWindow as AppointmentWindow)
  )
    return fail('invalid_selection');
  // Days are validated against what was offered when the picker listed days; a provider-slot
  // picker never accepts a free-form day.
  if (picker.mode !== 'request_only') return fail('invalid_selection');
  if (!(picker.days ?? []).includes(isoDate(date)))
    return fail('day_not_offered');
  // Never accept a day that is already over in the store timezone.
  const endOfDay = fromZoned({ ...date, hour: 23, minute: 59 }, p.timezone);
  if (endOfDay.getTime() <= p.now.getTime()) return fail('day_not_offered');
  return {
    ok: true,
    kind: 'request',
    picker,
    date,
    window: requestedWindow as AppointmentWindow,
  };
}

export function selectionRefusalText(
  reason: SelectionRefusal,
  lang: SalesDeskLang,
) {
  const es = lang === 'es';
  if (reason === 'already_booked')
    return es
      ? 'Esa tarjeta ya se usó para una reserva, así que no se reservó nada nuevo.'
      : 'That card was already used for a booking, so nothing new was booked.';
  if (reason === 'slot_expired')
    return es
      ? 'Ese horario ya no está vigente, así que no se reservó nada.'
      : 'That time is no longer on offer, so nothing was booked.';
  if (reason === 'day_not_offered')
    return es
      ? 'Ese día no está entre las opciones, así que no se envió nada.'
      : 'That day isn’t one of the options, so nothing was sent.';
  return es
    ? 'No pude usar esa selección, así que no se reservó nada.'
    : 'I couldn’t use that selection, so nothing was booked.';
}
