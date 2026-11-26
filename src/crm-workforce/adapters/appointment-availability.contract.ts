import type { Provenance, VerifiedFact } from '../crm-workforce.types';

/**
 * Contract for appointment availability and booking (sales visits, service, parts pickup).
 *
 * Today no authorized scheduling source exists for any rooftop, so production uses
 * `UnavailableSlotSource`: every lookup is BLOCKED and the workforce only creates appointment
 * REQUESTS for staff (work items). This file fixes, in advance, what a real source must provide
 * and how the system decides what it may offer a customer, so a Tekion scheduler / APC
 * integration plugs in without changing the rules.
 *
 * Rules (part of the contract):
 *  1. A slot may be offered only if it is verified, fresh (read within `maxAgeMinutes`), in the
 *     future (with lead time), inside the rooftop's verified hours, and for the right
 *     department and rooftop. Anything else is not offered — never guessed.
 *  2. Booking statuses are distinct: REQUESTED → HELD → BOOKED_UNVERIFIED → CONFIRMED.
 *     Only CONFIRMED (the source re-read and returned its own reference) may be told to the
 *     customer as booked. The output guard enforces this via `appointmentConfirmed`.
 *  3. Booking is idempotent per key, and re-checks the slot at booking time; a slot taken in the
 *     meantime yields SLOT_TAKEN, never a double booking.
 *  4. Unknown results are UNCERTAIN and are reconciled by a read before any retry.
 */
export type Department = 'SALES' | 'SERVICE' | 'PARTS';

export type Slot = Provenance & {
  slotId: string;
  department: Department;
  start: string; // ISO
  end: string; // ISO
  /** e.g. 'oil change', 'test drive'; free text from the source. */
  serviceType?: string | null;
  advisor?: string | null;
};

export type SlotQuery = {
  tenantId: string;
  locationId: string;
  department: Department;
  from: string;
  to: string;
  serviceType?: string;
};

export type SlotLookup =
  | { status: 'AVAILABLE'; slots: Slot[]; source: string }
  | { status: 'NONE'; slots: []; source: string }
  | {
      status: 'BLOCKED' | 'UNKNOWN';
      slots: [];
      source: string;
      reason: string;
    };

export type BookingStatus =
  | 'REQUESTED'
  | 'HELD'
  | 'BOOKED_UNVERIFIED'
  | 'CONFIRMED'
  | 'SLOT_TAKEN'
  | 'UNCERTAIN'
  | 'FAILED'
  | 'BLOCKED';

export type BookingRequest = {
  idempotencyKey: string;
  tenantId: string;
  locationId: string;
  slot: Slot;
  crmLeadRef: string;
};

export type BookingResult = {
  status: BookingStatus;
  /** The source's own appointment reference; required for CONFIRMED. */
  externalRef?: string;
  reason?: string;
};

export interface SlotSource {
  readonly key: string;
  lookup(q: SlotQuery): Promise<SlotLookup>;
  /** EXTERNAL side effect. Must be idempotent per `idempotencyKey`. */
  book(req: BookingRequest): Promise<BookingResult>;
  /** Separate read used to verify a booking and to reconcile UNCERTAIN results. */
  readBooking(req: BookingRequest): Promise<BookingResult>;
}

/** Production default: there is no authorized scheduling source. Nothing is offered or booked. */
export class UnavailableSlotSource implements SlotSource {
  readonly key = 'none';
  constructor(private readonly reason = 'no_authorized_scheduling_source') {}
  lookup(): Promise<SlotLookup> {
    return Promise.resolve({
      status: 'BLOCKED',
      slots: [],
      source: this.key,
      reason: this.reason,
    });
  }
  book(): Promise<BookingResult> {
    return Promise.resolve({ status: 'BLOCKED', reason: this.reason });
  }
  readBooking(): Promise<BookingResult> {
    return Promise.resolve({ status: 'BLOCKED', reason: this.reason });
  }
}

/** Store hours for one weekday, minutes from local midnight. */
export type DayHours = { open: number; close: number } | null;
export type VerifiedHours = Provenance & {
  timeZone: string;
  week: DayHours[]; /* 0 = Sunday */
};

export type OfferRules = {
  now: Date;
  maxAgeMinutes: number;
  leadTimeMinutes: number;
  hours: VerifiedHours | null;
  rooftopId: string;
  department: Department;
};

/** Local weekday and minutes-from-midnight of an instant in a time zone. */
function localParts(
  iso: string,
  timeZone: string,
): { day: number; minutes: number } {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const p = Object.fromEntries(
    f.formatToParts(new Date(iso)).map((x) => [x.type, x.value]),
  );
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
    p.weekday,
  );
  return { day, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

export type SlotRejection =
  | 'unverified'
  | 'stale'
  | 'past_or_too_soon'
  | 'outside_hours'
  | 'no_verified_hours'
  | 'wrong_rooftop'
  | 'wrong_department'
  | 'invalid';

/** Rule 1: which slots may be offered to a customer, and why the others may not. */
export function offerableSlots(
  lookup: SlotLookup,
  r: OfferRules,
): { offer: Slot[]; rejected: Array<{ slotId: string; why: SlotRejection }> } {
  const offer: Slot[] = [];
  const rejected: Array<{ slotId: string; why: SlotRejection }> = [];
  if (lookup.status !== 'AVAILABLE') return { offer, rejected };
  for (const s of lookup.slots) {
    const start = Date.parse(s.start);
    const end = Date.parse(s.end);
    const asOf = Date.parse(s.asOf);
    const why: SlotRejection | null =
      Number.isNaN(start) ||
      Number.isNaN(end) ||
      end <= start ||
      Number.isNaN(asOf)
        ? 'invalid'
        : !s.verified
          ? 'unverified'
          : s.rooftopId !== r.rooftopId
            ? 'wrong_rooftop'
            : s.department !== r.department
              ? 'wrong_department'
              : r.now.getTime() - asOf > r.maxAgeMinutes * 60_000
                ? 'stale'
                : start < r.now.getTime() + r.leadTimeMinutes * 60_000
                  ? 'past_or_too_soon'
                  : !r.hours?.verified
                    ? 'no_verified_hours'
                    : !insideHours(s, r.hours)
                      ? 'outside_hours'
                      : null;
    if (why) rejected.push({ slotId: s.slotId, why });
    else offer.push(s);
  }
  offer.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return { offer, rejected };
}

function insideHours(s: Slot, h: VerifiedHours): boolean {
  const a = localParts(s.start, h.timeZone);
  const b = localParts(
    new Date(Date.parse(s.end) - 1).toISOString(),
    h.timeZone,
  );
  const d = h.week[a.day];
  return !!d && a.day === b.day && a.minutes >= d.open && b.minutes < d.close;
}

/** A confirmed booking becomes the only kind of appointment fact a draft may state. */
export function confirmedAppointmentFact(
  result: BookingResult,
  req: BookingRequest,
): VerifiedFact | null {
  if (result.status !== 'CONFIRMED' || !result.externalRef) return null;
  return {
    kind: 'appointment',
    text: `Appointment confirmed ${req.slot.start} (${req.slot.department.toLowerCase()}), reference ${result.externalRef}`,
    sourceRecordId: result.externalRef,
    asOf: new Date().toISOString(),
    verified: true,
    rooftopId: req.slot.rooftopId,
  };
}

/**
 * Rules 2–4: drive one booking. Re-checks the slot, books once per idempotency key, and only
 * reports CONFIRMED when a separate read returns the source's own reference.
 */
export async function bookSlot(
  src: SlotSource,
  req: BookingRequest,
  q: SlotQuery,
): Promise<BookingResult> {
  const prior = await src.readBooking(req);
  if (prior.status === 'CONFIRMED') return prior; // retried request: already done
  const fresh = await src.lookup(q);
  if (fresh.status === 'BLOCKED' || fresh.status === 'UNKNOWN')
    return { status: 'BLOCKED', reason: fresh.reason };
  const current: Slot[] = fresh.slots;
  if (!current.some((s) => s.slotId === req.slot.slotId))
    return { status: 'SLOT_TAKEN' };
  let r: BookingResult;
  try {
    r = await src.book(req);
  } catch {
    r = { status: 'UNCERTAIN', reason: 'book_call_failed' };
  }
  if (
    r.status === 'SLOT_TAKEN' ||
    r.status === 'FAILED' ||
    r.status === 'BLOCKED'
  )
    return r;
  const check = await src.readBooking(req);
  if (check.status === 'CONFIRMED' && check.externalRef) return check;
  return {
    status: r.status === 'UNCERTAIN' ? 'UNCERTAIN' : 'BOOKED_UNVERIFIED',
    reason: 'not_confirmed_by_read_back',
  };
}

/** DEMO source for tests and demonstrations. Synthetic; never registered in production. */
export class FixtureSlotSource implements SlotSource {
  readonly key = 'fixture';
  private booked = new Map<string, string>(); // idempotencyKey -> ref
  private taken = new Set<string>();
  constructor(
    public slots: Slot[],
    private readonly opts: { confirm?: boolean; failBook?: boolean } = {
      confirm: true,
    },
  ) {}
  lookup(q: SlotQuery): Promise<SlotLookup> {
    const slots = this.slots.filter(
      (s) => s.department === q.department && !this.taken.has(s.slotId),
    );
    return Promise.resolve(
      slots.length
        ? { status: 'AVAILABLE', slots, source: this.key }
        : { status: 'NONE', slots: [], source: this.key },
    );
  }
  book(req: BookingRequest): Promise<BookingResult> {
    if (this.opts.failBook) return Promise.reject(new Error('timeout'));
    if (this.booked.has(req.idempotencyKey))
      return Promise.resolve({ status: 'HELD' });
    if (this.taken.has(req.slot.slotId))
      return Promise.resolve({ status: 'SLOT_TAKEN' });
    this.taken.add(req.slot.slotId);
    this.booked.set(req.idempotencyKey, `FIX-${this.booked.size + 1}`);
    return Promise.resolve({ status: 'HELD' });
  }
  readBooking(req: BookingRequest): Promise<BookingResult> {
    const ref = this.booked.get(req.idempotencyKey);
    if (!ref) return Promise.resolve({ status: 'REQUESTED' });
    return Promise.resolve(
      this.opts.confirm === false
        ? { status: 'BOOKED_UNVERIFIED' }
        : { status: 'CONFIRMED', externalRef: ref },
    );
  }
  /** Simulate another channel taking a slot. */
  take(slotId: string) {
    this.taken.add(slotId);
  }
}
