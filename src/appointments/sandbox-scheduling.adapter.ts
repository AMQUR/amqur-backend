import { createHash } from 'crypto';
import type {
  AvailabilitySlot,
  SchedulingCapabilities,
  SchedulingContext,
  SchedulingDepartment,
  SchedulingOutcome,
  ServiceSchedulingProviderAdapter,
} from './scheduling-provider';

/**
 * SANDBOX scheduler — a labelled demo stand-in, NOT a dealership scheduling integration.
 * It talks to no vendor, books nothing real, and is impossible to construct or register when
 * NODE_ENV=production. Everything it produces is marked `sandbox: true` and its references
 * are prefixed `SBX-` so a demo confirmation can never be mistaken for a real one.
 *
 * Behaviour is deterministic: a fixed UTC slot grid for the next few days, one designated
 * slot that is always "just taken" (to exercise the lost-race path), and at most one
 * confirmation per tenant/location/slot.
 */
export const SANDBOX_SCHEDULER_PROVIDER = 'MOCK';
export const SANDBOX_SCHEDULER_NAME = 'Sandbox scheduler';
export const SANDBOX_SLOT_HOURS_UTC = [15, 17, 19, 21] as const;
export const SANDBOX_HORIZON_DAYS = 4;
export const SANDBOX_SLOT_MINUTES = 45;
const TAKEN_HOUR_UTC = 17;

export function assertSandboxSchedulerAllowed(
  nodeEnv: string | undefined = process.env.NODE_ENV,
): void {
  if (nodeEnv === 'production')
    throw new Error('sandbox_scheduler_forbidden_in_production');
}

function dayStartUtc(now: Date, plusDays: number): number {
  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + plusDays,
  );
}

/** The deterministic grid: tomorrow..+4 days (UTC), four fixed starts per day. */
export function sandboxSlots(now: Date): AvailabilitySlot[] {
  const out: AvailabilitySlot[] = [];
  for (let d = 1; d <= SANDBOX_HORIZON_DAYS; d += 1) {
    for (const h of SANDBOX_SLOT_HOURS_UTC) {
      const start = new Date(dayStartUtc(now, d) + h * 3_600_000);
      out.push({
        startUtc: start.toISOString(),
        endUtc: new Date(
          start.getTime() + SANDBOX_SLOT_MINUTES * 60_000,
        ).toISOString(),
        providerSlotId: `sbx:${start.toISOString()}`,
      });
    }
  }
  return out;
}

/** The one slot the sandbox always rejects as already taken (second slot of the first day). */
export function sandboxTakenSlotStart(now: Date): string {
  return new Date(
    dayStartUtc(now, 1) + TAKEN_HOUR_UTC * 3_600_000,
  ).toISOString();
}

export function sandboxReference(
  idempotencyKey: string,
  startUtc: string,
): string {
  const h = createHash('sha256')
    .update(`${idempotencyKey}|${startUtc}`)
    .digest('hex')
    .slice(0, 6)
    .toUpperCase();
  return `SBX-${startUtc.slice(5, 7)}${startUtc.slice(8, 10)}-${startUtc.slice(11, 13)}-${h}`;
}

/** Durable "is this slot already confirmed for someone else?" lookup (survives restarts). */
export type SandboxBookedLookup = (
  ctx: SchedulingContext,
  startUtc: string,
) => Promise<boolean>;

export class SandboxSchedulingAdapter implements ServiceSchedulingProviderAdapter {
  readonly providerId = SANDBOX_SCHEDULER_PROVIDER;
  readonly displayName = SANDBOX_SCHEDULER_NAME;
  readonly sandbox = true;
  /** slot key → { idempotencyKey, ref } of the booking that holds it (process-local). */
  private readonly held = new Map<
    string,
    { key: string; ref: string; start: number }
  >();

  constructor(
    private readonly alreadyBooked: SandboxBookedLookup = () =>
      Promise.resolve(false),
  ) {
    assertSandboxSchedulerAllowed();
  }

  capabilities(): SchedulingCapabilities {
    return {
      availabilityRead: true,
      create: true,
      update: false,
      cancel: true,
      serviceTypes: false,
      transportationOptions: false,
    };
  }

  private slotKey(ctx: SchedulingContext, startUtc: string) {
    return `${ctx.tenantId}:${ctx.locationId ?? ''}:${startUtc}`;
  }

  private prune(now: Date) {
    for (const [k, v] of this.held)
      if (v.start < now.getTime()) this.held.delete(k);
  }

  getAvailability(
    ctx: SchedulingContext,
    q: {
      department: SchedulingDepartment;
      fromUtc: string;
      toUtc: string;
      serviceType?: string;
    },
  ): Promise<AvailabilitySlot[]> {
    assertSandboxSchedulerAllowed();
    const now = ctx.now ?? new Date();
    const from = Date.parse(q.fromUtc);
    const to = Date.parse(q.toUtc);
    return Promise.resolve(
      sandboxSlots(now).filter((s) => {
        const t = Date.parse(s.startUtc);
        // Slots already held by another booking are not offered; the designated "taken" slot
        // stays visible on purpose so the lost-race path can be exercised.
        return (
          t >= from && t <= to && !this.held.has(this.slotKey(ctx, s.startUtc))
        );
      }),
    );
  }

  async create(
    ctx: SchedulingContext,
    req: { department: SchedulingDepartment; startUtc: string },
  ): Promise<SchedulingOutcome> {
    assertSandboxSchedulerAllowed();
    const now = ctx.now ?? new Date();
    const start = new Date(req.startUtc);
    const startUtc = Number.isNaN(start.getTime()) ? '' : start.toISOString();
    const grid = sandboxSlots(now);
    const alternatives = grid
      .filter(
        (s) =>
          s.startUtc !== sandboxTakenSlotStart(now) &&
          !this.held.has(this.slotKey(ctx, s.startUtc)),
      )
      .slice(0, 3);
    if (!grid.some((s) => s.startUtc === startUtc))
      return {
        kind: 'unavailable',
        reason: 'not_a_sandbox_slot',
        alternatives,
      };
    if (startUtc === sandboxTakenSlotStart(now))
      return { kind: 'unavailable', reason: 'slot_taken', alternatives };

    this.prune(now);
    const key = this.slotKey(ctx, startUtc);
    const holder = this.held.get(key);
    if (holder && holder.key !== ctx.idempotencyKey)
      return { kind: 'unavailable', reason: 'slot_taken', alternatives };
    const ref = sandboxReference(ctx.idempotencyKey, startUtc);
    // Claim synchronously (single-threaded) BEFORE any await: two concurrent selections of the
    // same slot can never both pass this point.
    this.held.set(key, {
      key: ctx.idempotencyKey,
      ref,
      start: start.getTime(),
    });
    if (!holder && (await this.alreadyBooked(ctx, startUtc))) {
      this.held.delete(key);
      return { kind: 'unavailable', reason: 'slot_taken', alternatives };
    }
    return {
      kind: 'confirmed',
      externalId: ref,
      providerStatus: 'CONFIRMED',
      rawStatus: 'SANDBOX_CONFIRMED',
      scheduledAtUtc: startUtc,
      providerRequestId: ctx.correlationId,
    };
  }

  private heldByKey(ctx: SchedulingContext) {
    const prefix = `${ctx.tenantId}:${ctx.locationId ?? ''}:`;
    return [...this.held].filter(
      ([k, v]) => k.startsWith(prefix) && v.key === ctx.idempotencyKey,
    );
  }

  /** The booking made under this idempotency key, if the sandbox holds one. Creates nothing. */
  findByIdempotencyKey(
    ctx: SchedulingContext,
  ): Promise<Extract<SchedulingOutcome, { kind: 'confirmed' }> | null> {
    assertSandboxSchedulerAllowed();
    const hit = this.heldByKey(ctx)[0];
    if (!hit) return Promise.resolve(null);
    return Promise.resolve({
      kind: 'confirmed',
      externalId: hit[1].ref,
      providerStatus: 'CONFIRMED',
      rawStatus: 'SANDBOX_CONFIRMED',
      scheduledAtUtc: new Date(hit[1].start).toISOString(),
      providerRequestId: ctx.correlationId,
    });
  }

  cancelByIdempotencyKey(
    ctx: SchedulingContext,
  ): Promise<{ cancelled: boolean; externalId?: string }> {
    assertSandboxSchedulerAllowed();
    const hits = this.heldByKey(ctx);
    for (const [k] of hits) this.held.delete(k);
    return Promise.resolve({
      cancelled: hits.length > 0,
      ...(hits[0] ? { externalId: hits[0][1].ref } : {}),
    });
  }

  cancel(
    _ctx: SchedulingContext,
    externalId: string,
  ): Promise<SchedulingOutcome> {
    assertSandboxSchedulerAllowed();
    for (const [k, v] of this.held)
      if (v.ref === externalId) this.held.delete(k);
    return Promise.resolve({
      kind: 'pending',
      externalId,
      providerStatus: 'SANDBOX_CANCELLED',
    });
  }
}
