import {
  addDays,
  LocalDate,
  parseClock,
  parseIsoDate,
  toZoned,
  WEEKDAY_KEYS,
} from './zoned-time';

export type PartOfDay = 'morning' | 'afternoon' | 'evening';

export type ResolvedWhen = {
  date?: LocalDate;
  /** minutes after local midnight */
  time?: number;
  partOfDay?: PartOfDay;
  /** text that produced the match (for audit / requestedPhrase) */
  phrase: string;
  /** true when a weekday/time was explicitly ambiguous (e.g. "at 3" w/o am/pm) and we inferred */
  inferred: boolean;
};

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  sun: 0,
  domingo: 0,
  monday: 1,
  mon: 1,
  lunes: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  martes: 2,
  wednesday: 3,
  wed: 3,
  miercoles: 3,
  miércoles: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  jueves: 4,
  friday: 5,
  fri: 5,
  viernes: 5,
  saturday: 6,
  sat: 6,
  sabado: 6,
  sábado: 6,
};

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  enero: 1,
  feb: 2,
  february: 2,
  febrero: 2,
  mar: 3,
  march: 3,
  marzo: 3,
  apr: 4,
  april: 4,
  abril: 4,
  may: 5,
  mayo: 5,
  jun: 6,
  june: 6,
  junio: 6,
  jul: 7,
  july: 7,
  julio: 7,
  aug: 8,
  august: 8,
  agosto: 8,
  sep: 9,
  sept: 9,
  september: 9,
  septiembre: 9,
  oct: 10,
  october: 10,
  octubre: 10,
  nov: 11,
  november: 11,
  noviembre: 11,
  dec: 12,
  december: 12,
  diciembre: 12,
};

/**
 * Resolve natural date/time language relative to the DEALERSHIP's local "now".
 * Pure + deterministic given `now` and `timeZone` — never uses server-local time.
 */
export function resolveWhen(
  text: string,
  timeZone: string,
  now: Date = new Date(),
): ResolvedWhen | null {
  const t = ` ${text.toLowerCase().replace(/[,!?]/g, ' ')} `;
  const z = toZoned(now, timeZone);
  const today: LocalDate = { year: z.year, month: z.month, day: z.day };
  const todayIdx = WEEKDAY_KEYS.indexOf(z.weekday);

  let date: LocalDate | undefined;
  let inferred = false;
  const phrases: string[] = [];

  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(t);
  if (iso) {
    const d = parseIsoDate(iso[1]);
    if (d) {
      date = d;
      phrases.push(iso[1]);
    }
  }

  if (!date) {
    if (/\b(today|tonight|hoy|esta noche)\b/.test(t)) {
      date = today;
      phrases.push('today');
    } else if (/\b(day after tomorrow|pasado mañana|pasado manana)\b/.test(t)) {
      date = addDays(today, 2);
      phrases.push('day after tomorrow');
    } else if (/\b(tomorrow|tmrw|tmr|mañana|manana)\b/.test(t)) {
      date = addDays(today, 1);
      phrases.push('tomorrow');
    }
  }

  if (!date) {
    const md =
      /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?\b/.exec(
        t,
      );
    const slash = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(t);
    let month: number | undefined;
    let day: number | undefined;
    let year: number | undefined;
    if (md) {
      month = MONTHS[md[1]];
      day = Number(md[2]);
      phrases.push(md[0].trim());
    } else if (slash) {
      month = Number(slash[1]);
      day = Number(slash[2]);
      if (slash[3])
        year = Number(slash[3].length === 2 ? `20${slash[3]}` : slash[3]);
      phrases.push(slash[0]);
    }
    if (month && day) {
      let y = year ?? today.year;
      let cand = parseIsoDate(
        `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      );
      if (cand && !year) {
        const candKey = cand.year * 10000 + cand.month * 100 + cand.day;
        const todayKey = today.year * 10000 + today.month * 100 + today.day;
        if (candKey < todayKey) {
          y += 1;
          inferred = true;
          cand = parseIsoDate(
            `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
          );
        }
      }
      if (cand) date = cand;
    }
  }

  if (!date) {
    const wd =
      /\b(next|this|el|este|próximo|proximo)?\s*(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat|domingo|lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado)\b/.exec(
        t,
      );
    if (wd) {
      const target = WEEKDAYS[wd[2]];
      let diff = (target - todayIdx + 7) % 7;
      const qualifier = wd[1];
      if (
        qualifier === 'next' ||
        qualifier === 'próximo' ||
        qualifier === 'proximo'
      ) {
        // "next Saturday" is genuinely ambiguous in US English. Resolve to the upcoming one
        // (never today) and flag as inferred so the assistant restates the exact date.
        if (diff === 0) diff = 7;
        inferred = true;
      }
      // bare weekday equal to today means today (e.g. "Saturday" said on Saturday)
      date = addDays(today, diff);
      phrases.push(wd[0].trim());
    }
  }

  // time
  let time: number | undefined;
  const timeRe =
    /\b(?:at|@|around|by|a las|las)?\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|am|pm)\b|\b(?:at|@|around|a las)\s+(\d{1,2})(?::(\d{2}))?\b|\b(noon|mediodía|mediodia)\b/;
  const tm = timeRe.exec(t);
  if (tm) {
    if (tm[6]) {
      time = 12 * 60;
    } else if (tm[1]) {
      const raw = `${tm[1]}:${tm[2] ?? '00'} ${tm[3].replace(/\./g, '')}`;
      time = parseClock(raw) ?? undefined;
    } else if (tm[4]) {
      // "at 3" — no meridiem. Dealership hours make 1-7 almost always PM.
      let h = Number(tm[4]);
      const m = tm[5] ? Number(tm[5]) : 0;
      if (h >= 1 && h <= 7) {
        h += 12;
        inferred = true;
      }
      if (h <= 23 && m <= 59) time = h * 60 + m;
    }
    if (time !== undefined) phrases.push(tm[0].trim());
  }

  let partOfDay: PartOfDay | undefined;
  if (/\b(morning|mañana temprano|por la mañana|am only)\b/.test(t))
    partOfDay = 'morning';
  else if (/\b(afternoon|por la tarde|tarde)\b/.test(t))
    partOfDay = 'afternoon';
  else if (/\b(evening|tonight|por la noche|noche)\b/.test(t))
    partOfDay = 'evening';
  if (partOfDay) phrases.push(partOfDay);

  if (!date && time === undefined && !partOfDay) return null;
  return {
    date,
    time,
    partOfDay,
    phrase: phrases.join(' ').trim() || text.trim().slice(0, 80),
    inferred,
  };
}
