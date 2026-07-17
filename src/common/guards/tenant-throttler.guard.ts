import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Tenant-aware rate limiting.
 *
 * The default ThrottlerGuard tracker is client IP only. Behind a shared
 * proxy/NAT that gives every dealership's visitors one bucket, and a burst
 * against tenant A consumes the same bucket tenant B's visitors rely on.
 *
 * This tracker scopes the bucket to `${tenantSlug}:${ip}` whenever the
 * request carries a tenant slug (public widget endpoints put it in the
 * body or query). One tenant under load therefore never drains another
 * tenant's allowance. Requests without a tenant slug fall back to per-IP.
 *
 * 429 behavior: the client receives HTTP 429 with a Retry-After header;
 * buckets are per route x per tracker with the TTLs configured in
 * ThrottlerModule (see docs/operations/rate-limits.md).
 */
@Injectable()
export class TenantThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const ip: string =
      (Array.isArray(req.ips) && req.ips.length ? req.ips[0] : req.ip) ??
      'unknown';
    const tenantSlug: unknown =
      req.body?.tenantSlug ?? req.query?.tenantSlug ?? null;
    return typeof tenantSlug === 'string' && tenantSlug
      ? `${tenantSlug}:${ip}`
      : ip;
  }
}
