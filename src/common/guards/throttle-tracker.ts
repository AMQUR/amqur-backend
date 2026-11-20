/**
 * Rate-limit bucket key ("tracker") for one request.
 *
 * Guards run before validation, so NOTHING the client can freely choose (a `tenantSlug` in the
 * body or query, a conversation id, a header) may select the bucket: a value the caller rotates
 * would hand them a fresh allowance on every request.
 *
 * - Authenticated request (JwtAuthGuard already verified the token and set `req.user`):
 *   - widget token  → `w:<tenantId>:<ip>`. The tenant comes from the signed token. The token
 *     subject is deliberately NOT part of the key: widget tokens are minted anonymously, so a
 *     per-token bucket could be reset by minting another token.
 *   - staff token   → `u:<tenantId>:<userId>`.
 * - Public (unauthenticated) request → `ip:<ip>`. A client-supplied slug never creates a bucket.
 */
type TrackerRequest = {
  ip?: unknown;
  ips?: unknown;
  user?: unknown;
};

/** First proxy hop when Express `trust proxy` populated `req.ips`, else the socket address. */
export function clientIp(req: TrackerRequest): string {
  const ips = req.ips;
  if (Array.isArray(ips) && ips.length && typeof ips[0] === 'string') {
    return ips[0];
  }
  return typeof req.ip === 'string' && req.ip ? req.ip : 'unknown';
}

export function resolveThrottleTracker(req: TrackerRequest): string {
  const ip = clientIp(req);
  const user = req.user;
  if (user && typeof user === 'object') {
    const u = user as Record<string, unknown>;
    const tenantId = typeof u.tenantId === 'string' ? u.tenantId : '';
    if (tenantId) {
      const sub = typeof u.sub === 'string' ? u.sub : '';
      if (u.role !== 'widget' && sub) return `u:${tenantId}:${sub}`;
      return `w:${tenantId}:${ip}`;
    }
  }
  return `ip:${ip}`;
}
