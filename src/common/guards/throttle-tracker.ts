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
  headers?: Record<string, unknown>;
};

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9a-f:]{2,39}$/i;

/**
 * The client address. On Railway (TRUST_X_REAL_IP=true) the edge sets `X-Real-IP` to the
 * caller's address and overwrites any client-sent value; X-Forwarded-For can carry an extra
 * edge hop there, which split one shopper across several buckets. Elsewhere: the first trusted
 * proxy hop when Express `trust proxy` populated `req.ips`, else the socket address.
 */
export function clientIp(
  req: TrackerRequest,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.TRUST_X_REAL_IP === 'true') {
    const raw = req.headers?.['x-real-ip'];
    const v = (Array.isArray(raw) ? raw[0] : raw) as unknown;
    if (typeof v === 'string') {
      const ip = v.trim();
      if (IPV4.test(ip) || IPV6.test(ip)) return ip;
    }
  }
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
