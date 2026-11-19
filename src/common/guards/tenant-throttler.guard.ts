import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { resolveThrottleTracker } from './throttle-tracker';

/**
 * Rate-limit buckets keyed by who the caller verifiably is.
 *
 * The tracker comes from `resolveThrottleTracker` (see throttle-tracker.ts): the signed token's
 * tenant for authenticated traffic, the client IP for public routes. This guard is registered
 * AFTER JwtAuthGuard, so `req.user` is already verified when the tracker is computed.
 *
 * A `tenantSlug` in the body or query is client-controlled and is never part of the key:
 * guards run before validation, so a rotated slug would otherwise mint a fresh bucket per
 * request (unlimited throughput from one IP).
 *
 * 429 behavior: the client receives HTTP 429 with a Retry-After header;
 * buckets are per route x per tracker with the TTLs configured in
 * ThrottlerModule (see docs/operations/rate-limits.md).
 */
@Injectable()
export class TenantThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, any>): Promise<string> {
    return Promise.resolve(resolveThrottleTracker(req));
  }
}
