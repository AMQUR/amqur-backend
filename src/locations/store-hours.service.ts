import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  addDays,
  formatClock,
  fromZoned,
  isoDate,
  isValidTimeZone,
  LocalDate,
  parseClock,
  parseIsoDate,
  toZoned,
  WEEKDAY_KEYS,
  weekdayOf,
  WeekdayKey,
} from '../common/time/zoned-time';

export type Department = 'store' | 'sales' | 'service' | 'parts';

type DayHours = { open: number; close: number } | null; // minutes; null = closed

export type WeeklyHours = Record<WeekdayKey, DayHours>;

export type HolidayEntry = {
  date: string;
  closed?: boolean;
  open?: string;
  close?: string;
  note?: string;
  departments?: Department[];
};

export type HoursProfile = {
  locationId: string;
  locationName: string;
  timezone: string;
  verified: boolean;
  verifiedAt: string | null;
  weekly: Partial<Record<Department, WeeklyHours>>;
  holidays: HolidayEntry[];
};

export type DayResolution = {
  date: string;
  weekday: WeekdayKey;
  open: number | null;
  close: number | null;
  closed: boolean;
  reason: 'weekly' | 'holiday' | 'closed_weekly' | 'unknown';
  note?: string;
};

export type SlotValidation =
  | { ok: true; day: DayResolution; instant: Date }
  | {
      ok: false;
      code:
        | 'hours_unverified'
        | 'closed_day'
        | 'outside_hours'
        | 'in_past'
        | 'invalid';
      day?: DayResolution;
    };

const KEY_ALIASES: Record<string, WeekdayKey> = {
  sun: 'sun',
  sunday: 'sun',
  mon: 'mon',
  monday: 'mon',
  tue: 'tue',
  tues: 'tue',
  tuesday: 'tue',
  wed: 'wed',
  wednesday: 'wed',
  thu: 'thu',
  thur: 'thu',
  thurs: 'thu',
  thursday: 'thu',
  fri: 'fri',
  friday: 'fri',
  sat: 'sat',
  saturday: 'sat',
  '0': 'sun',
  '1': 'mon',
  '2': 'tue',
  '3': 'wed',
  '4': 'thu',
  '5': 'fri',
  '6': 'sat',
};

/** Parse a JSON weekly-hours blob into minutes. Unknown/invalid entries become "unknown" (absent). */
export function parseWeekly(raw: unknown): WeeklyHours | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Partial<WeeklyHours> = {};
  let any = false;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = KEY_ALIASES[k.toLowerCase()];
    if (!key) continue;
    if (v === null || v === false || v === 'closed') {
      out[key] = null;
      any = true;
      continue;
    }
    if (typeof v === 'object' && v) {
      const o = v as Record<string, unknown>;
      if (o.closed === true) {
        out[key] = null;
        any = true;
        continue;
      }
      const open = typeof o.open === 'string' ? parseClock(o.open) : null;
      const close = typeof o.close === 'string' ? parseClock(o.close) : null;
      if (open !== null && close !== null && close > open) {
        out[key] = { open, close };
        any = true;
      }
    }
  }
  if (!any) return null;
  // Days not listed are treated as closed only when at least one day is explicitly configured.
  for (const k of WEEKDAY_KEYS) if (!(k in out)) out[k] = null;
  return out as WeeklyHours;
}

/**
 * Single source of truth for dealership hours: displayed hours, "open now",
 * appointment validation, widget status and campaign quiet hours all go through here.
 * No hard-coded defaults — unverified/missing hours return `verified:false`.
 */
@Injectable()
export class StoreHoursService {
  constructor(private readonly prisma: PrismaService) {}

  async getProfile(
    tenantId: string,
    locationId: string | null | undefined,
  ): Promise<HoursProfile | null> {
    if (!locationId) return null;
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, tenantId },
      select: {
        id: true,
        name: true,
        timezone: true,
        storeHours: true,
        departmentHours: true,
        holidayHours: true,
        storeHoursVerifiedAt: true,
      },
    });
    if (!loc) return null;
    return StoreHoursService.buildProfile(loc);
  }

  static buildProfile(loc: {
    id: string;
    name: string;
    timezone: string;
    storeHours: unknown;
    departmentHours?: unknown;
    holidayHours?: unknown;
    storeHoursVerifiedAt?: Date | null;
  }): HoursProfile {
    const tz = isValidTimeZone(loc.timezone) ? loc.timezone : 'America/Chicago';
    const weekly: Partial<Record<Department, WeeklyHours>> = {};
    const store = parseWeekly(loc.storeHours);
    if (store) weekly.store = store;
    if (loc.departmentHours && typeof loc.departmentHours === 'object') {
      for (const dep of ['sales', 'service', 'parts'] as const) {
        const w = parseWeekly(
          (loc.departmentHours as Record<string, unknown>)[dep],
        );
        if (w) weekly[dep] = w;
      }
    }
    const holidays: HolidayEntry[] = Array.isArray(loc.holidayHours)
      ? (loc.holidayHours as unknown[]).filter(
          (h): h is HolidayEntry =>
            !!h &&
            typeof h === 'object' &&
            typeof (h as HolidayEntry).date === 'string' &&
            !!parseIsoDate((h as HolidayEntry).date),
        )
      : [];
    // Hours count as verified only if configured AND explicitly verified by staff.
    const verified = !!store && !!loc.storeHoursVerifiedAt;
    return {
      locationId: loc.id,
      locationName: loc.name,
      timezone: tz,
      verified,
      verifiedAt: loc.storeHoursVerifiedAt?.toISOString() ?? null,
      weekly,
      holidays,
    };
  }

  static resolveDay(
    profile: HoursProfile,
    date: LocalDate,
    department: Department = 'store',
  ): DayResolution {
    const key = isoDate(date);
    const weekday = weekdayOf(date);
    const holiday = profile.holidays.find(
      (h) =>
        h.date === key &&
        (!h.departments ||
          h.departments.length === 0 ||
          h.departments.includes(department)),
    );
    if (holiday) {
      if (holiday.closed) {
        return {
          date: key,
          weekday,
          open: null,
          close: null,
          closed: true,
          reason: 'holiday',
          note: holiday.note,
        };
      }
      const o = holiday.open ? parseClock(holiday.open) : null;
      const c = holiday.close ? parseClock(holiday.close) : null;
      if (o !== null && c !== null && c > o) {
        return {
          date: key,
          weekday,
          open: o,
          close: c,
          closed: false,
          reason: 'holiday',
          note: holiday.note,
        };
      }
    }
    const weekly = profile.weekly[department] ?? profile.weekly.store;
    if (!weekly) {
      return {
        date: key,
        weekday,
        open: null,
        close: null,
        closed: false,
        reason: 'unknown',
      };
    }
    const day = weekly[weekday];
    if (!day) {
      return {
        date: key,
        weekday,
        open: null,
        close: null,
        closed: true,
        reason: 'closed_weekly',
      };
    }
    return {
      date: key,
      weekday,
      open: day.open,
      close: day.close,
      closed: false,
      reason: 'weekly',
    };
  }

  static isOpenAt(
    profile: HoursProfile,
    instant: Date,
    department: Department = 'store',
  ): {
    known: boolean;
    open: boolean;
    closesAt?: number;
    nextOpen?: { date: string; open: number };
  } {
    if (!profile.verified) return { known: false, open: false };
    const z = toZoned(instant, profile.timezone);
    const today: LocalDate = { year: z.year, month: z.month, day: z.day };
    const day = StoreHoursService.resolveDay(profile, today, department);
    const mins = z.hour * 60 + z.minute;
    if (day.reason === 'unknown') return { known: false, open: false };
    if (
      !day.closed &&
      day.open !== null &&
      day.close !== null &&
      mins >= day.open &&
      mins < day.close
    ) {
      return { known: true, open: true, closesAt: day.close };
    }
    for (
      let i = day.open !== null && mins < day.open ? 0 : 1;
      i <= 14;
      i += 1
    ) {
      const d = StoreHoursService.resolveDay(
        profile,
        addDays(today, i),
        department,
      );
      if (!d.closed && d.open !== null) {
        return {
          known: true,
          open: false,
          nextOpen: { date: d.date, open: d.open },
        };
      }
    }
    return { known: true, open: false };
  }

  /**
   * Validate a requested appointment slot in the dealership's timezone.
   * `lastBookableMinutesBeforeClose` keeps requests off the closing minute.
   */
  static validateSlot(
    profile: HoursProfile | null,
    date: LocalDate,
    minutes: number,
    opts: {
      department?: Department;
      now?: Date;
      lastBookableMinutesBeforeClose?: number;
    } = {},
  ): SlotValidation {
    if (!profile || !profile.verified)
      return { ok: false, code: 'hours_unverified' };
    if (minutes < 0 || minutes >= 24 * 60)
      return { ok: false, code: 'invalid' };
    const day = StoreHoursService.resolveDay(
      profile,
      date,
      opts.department ?? 'store',
    );
    if (day.reason === 'unknown')
      return { ok: false, code: 'hours_unverified', day };
    if (day.closed || day.open === null || day.close === null) {
      return { ok: false, code: 'closed_day', day };
    }
    const buffer = opts.lastBookableMinutesBeforeClose ?? 30;
    if (minutes < day.open || minutes > day.close - buffer) {
      return { ok: false, code: 'outside_hours', day };
    }
    const instant = fromZoned(
      { ...date, hour: Math.floor(minutes / 60), minute: minutes % 60 },
      profile.timezone,
    );
    if (instant.getTime() <= (opts.now ?? new Date()).getTime()) {
      return { ok: false, code: 'in_past', day };
    }
    return { ok: true, day, instant };
  }

  /** Customer-facing weekly summary from verified hours only. */
  static summarize(
    profile: HoursProfile,
    department: Department = 'store',
    locale = 'en',
  ): string | null {
    if (!profile.verified) return null;
    const weekly = profile.weekly[department] ?? profile.weekly.store;
    if (!weekly) return null;
    const names: Record<string, Record<WeekdayKey, string>> = {
      en: {
        mon: 'Mon',
        tue: 'Tue',
        wed: 'Wed',
        thu: 'Thu',
        fri: 'Fri',
        sat: 'Sat',
        sun: 'Sun',
      },
      es: {
        mon: 'lun',
        tue: 'mar',
        wed: 'mié',
        thu: 'jue',
        fri: 'vie',
        sat: 'sáb',
        sun: 'dom',
      },
    };
    const closedWord = locale.startsWith('es') ? 'cerrado' : 'closed';
    const n = names[locale.startsWith('es') ? 'es' : 'en'];
    const order: WeekdayKey[] = [
      'mon',
      'tue',
      'wed',
      'thu',
      'fri',
      'sat',
      'sun',
    ];
    const fmt = (d: DayHours) =>
      d
        ? `${formatClock(d.open, locale)}–${formatClock(d.close, locale)}`
        : closedWord;
    const groups: Array<{ from: WeekdayKey; to: WeekdayKey; label: string }> =
      [];
    for (const k of order) {
      const label = fmt(weekly[k]);
      const last = groups[groups.length - 1];
      if (last && last.label === label) last.to = k;
      else groups.push({ from: k, to: k, label });
    }
    return groups
      .map(
        (g) =>
          `${g.from === g.to ? n[g.from] : `${n[g.from]}–${n[g.to]}`} ${g.label}`,
      )
      .join(', ');
  }
}
