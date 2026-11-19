import { createHash } from 'crypto';

/**
 * Cap on concurrently open `POST /chat/stream` turns.
 *
 * The per-minute throttle bounds how many turns a caller may START; it does not bound how many
 * are in flight at once. A stream is cheap to open and (by design, see ChatController.stream) the
 * turn keeps running after the client disconnects, so without a cap one caller could hold many
 * model turns open at the same time by opening and dropping connections.
 *
 * A slot is held from before the response starts until the TURN finishes — not until the socket
 * closes — so disconnecting does not hand the slot back early.
 *
 * Counters are per process (like the throttler's storage); with N API replicas the effective cap
 * is N x the configured value.
 */
export const STREAM_CAP_DEFAULTS = { perIp: 10, perToken: 4 } as const;

function cap(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : fallback;
}

export function streamCaps(env: NodeJS.ProcessEnv = process.env): {
  perIp: number;
  perToken: number;
} {
  return {
    perIp: cap(
      env.CHAT_STREAM_MAX_CONCURRENT_PER_IP,
      STREAM_CAP_DEFAULTS.perIp,
    ),
    perToken: cap(
      env.CHAT_STREAM_MAX_CONCURRENT_PER_TOKEN,
      STREAM_CAP_DEFAULTS.perToken,
    ),
  };
}

/** Opaque, non-reversible key for a bearer credential (never log or store the token itself). */
export function tokenKey(authorization: unknown): string | null {
  if (typeof authorization !== 'string' || !authorization) return null;
  return createHash('sha256').update(authorization).digest('hex').slice(0, 32);
}

export class StreamConcurrencyLimiter {
  private readonly open = new Map<string, number>();

  /**
   * Takes one slot under every key, or none at all. Returns a release function (idempotent), or
   * `null` when any key is already at its cap.
   */
  acquire(slots: Array<{ key: string; max: number }>): (() => void) | null {
    for (const s of slots) {
      if ((this.open.get(s.key) ?? 0) >= s.max) return null;
    }
    for (const s of slots)
      this.open.set(s.key, (this.open.get(s.key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const s of slots) {
        const n = (this.open.get(s.key) ?? 1) - 1;
        if (n <= 0) this.open.delete(s.key);
        else this.open.set(s.key, n);
      }
    };
  }

  /** Open streams under a key (tests/metrics). */
  count(key: string): number {
    return this.open.get(key) ?? 0;
  }
}

/** Process-wide limiter used by the chat stream endpoint. */
export const chatStreamLimiter = new StreamConcurrencyLimiter();

export const STREAM_BUSY_RETRY_AFTER_SECONDS = 5;
