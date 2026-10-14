/**
 * DST-safe wall-clock ↔ instant conversion for dealership timezones using Intl only
 * (no extra dependency). Dealership appointment times are ALWAYS interpreted in the
 * location's IANA timezone — never server UTC.
 */

export type LocalDate = { year: number; month: number; day: number }; // month 1-12
export type LocalDateTime = LocalDate & { hour: number; minute: number };

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = dtfCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    dtfCache.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of `instant` in `timeZone`. */
export function toZoned(
  instant: Date,
  timeZone: string,
): LocalDateTime & { weekday: WeekdayKey; second: number } {
  const parts = formatter(timeZone).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const wd = get('weekday').toLowerCase().slice(0, 3) as WeekdayKey;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: wd,
  };
}

function offsetMs(instant: Date, timeZone: string): number {
  const z = toZoned(instant, timeZone);
  const asUtc = Date.UTC(
    z.year,
    z.month - 1,
    z.day,
    z.hour,
    z.minute,
    z.second,
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * Instant for a dealership wall-clock time. For a non-existent local time (spring-forward gap)
 * the result moves forward by the gap; for an ambiguous time (fall-back) the earlier instant wins.
 */
export function fromZoned(local: LocalDateTime, timeZone: string): Date {
  const guess = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
  );
  const off1 = offsetMs(new Date(guess), timeZone);
  let t = guess - off1;
  const off2 = offsetMs(new Date(t), timeZone);
  if (off2 !== off1) {
    const alt = guess - off2;
    // choose earlier valid instant for ambiguity; for gaps alt maps forward
    t = Math.min(t, alt);
    const back = toZoned(new Date(t), timeZone);
    if (back.hour !== local.hour || back.minute !== local.minute) {
      t = Math.max(guess - off1, alt);
    }
  }
  return new Date(t);
}

export function weekdayOf(d: LocalDate): WeekdayKey {
  const idx = new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
  return WEEKDAY_KEYS[idx];
}

export function addDays(d: LocalDate, n: number): LocalDate {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + n));
  return {
    year: t.getUTCFullYear(),
    month: t.getUTCMonth() + 1,
    day: t.getUTCDate(),
  };
}

export function isoDate(d: LocalDate): string {
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

export function parseIsoDate(s: string): LocalDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const d = { year: +m[1], month: +m[2], day: +m[3] };
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day));
  if (t.getUTCMonth() + 1 !== d.month || t.getUTCDate() !== d.day) return null;
  return d;
}

/** "09:00" | "9:00 AM" | "3pm" | "15:30" → minutes after midnight, or null. */
export function parseClock(input: string): number | null {
  const t = input.trim().toLowerCase().replace(/\./g, '');
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?$/.exec(t);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const suf = m[3];
  if (min > 59) return null;
  if (suf) {
    if (h < 1 || h > 12) return null;
    const pm = suf.startsWith('p');
    if (pm && h !== 12) h += 12;
    if (!pm && h === 12) h = 0;
  } else if (h > 23) {
    return null;
  }
  return h * 60 + min;
}

export function formatClock(minutes: number, locale = 'en'): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (locale.startsWith('es')) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0
    ? `${h12} ${suffix}`
    : `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

export { WEEKDAY_KEYS };
