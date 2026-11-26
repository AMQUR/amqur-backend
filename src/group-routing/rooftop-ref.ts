import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Opaque rooftop reference the widget may echo back with a vehicle.
 *
 *   rr1.<expiry, base36 seconds>.<128-bit keyed hash, base64url>
 *
 * It contains no tenant id, slug or location id. The hash binds (group, rooftop, THIS
 * conversation, expiry), so a reference cannot be enumerated, reused in another conversation,
 * replayed after it expires, or minted for a rooftop outside the group: verification only ever
 * compares against the group's server-resolved member list.
 */
export const ROOFTOP_REF_TTL_MS = 24 * 60 * 60 * 1000;
const BUCKET_MS = 60 * 60 * 1000;
const REF_RE = /^rr1\.([0-9a-z]{1,9})\.([A-Za-z0-9_-]{22})$/;

export function groupRoutingKey(secret: string): Buffer {
  return createHmac('sha256', secret).update('amqur.group-routing.v1').digest();
}

function mac(key: Buffer, parts: string[]): string {
  return createHmac('sha256', key)
    .update(parts.map((p) => `${p.length}:${p}`).join('|'))
    .digest()
    .subarray(0, 16)
    .toString('base64url');
}

export function signRooftopRef(
  key: Buffer,
  p: {
    dealerGroupId: string;
    tenantId: string;
    conversationKey: string;
    nowMs: number;
    ttlMs?: number;
  },
): string {
  // Rounded up to the hour so a vehicle keeps the same reference across nearby turns.
  const expMs =
    Math.ceil((p.nowMs + (p.ttlMs ?? ROOFTOP_REF_TTL_MS)) / BUCKET_MS) *
    BUCKET_MS;
  const exp = Math.floor(expMs / 1000).toString(36);
  return `rr1.${exp}.${mac(key, ['ref', p.dealerGroupId, p.tenantId, p.conversationKey, exp])}`;
}

/** Returns the member tenant id the reference was issued for, or null (forged/expired/other). */
export function verifyRooftopRef(
  key: Buffer,
  p: {
    dealerGroupId: string;
    conversationKey: string;
    nowMs: number;
    memberTenantIds: readonly string[];
  },
  ref: string | null | undefined,
): string | null {
  if (!ref || ref.length > 64) return null;
  const m = REF_RE.exec(ref);
  if (!m) return null;
  const expSec = parseInt(m[1], 36);
  if (!Number.isFinite(expSec) || expSec * 1000 <= p.nowMs) return null;
  const got = Buffer.from(m[2]);
  let found: string | null = null;
  for (const tenantId of p.memberTenantIds) {
    const want = Buffer.from(
      mac(key, ['ref', p.dealerGroupId, tenantId, p.conversationKey, m[1]]),
    );
    if (want.length === got.length && timingSafeEqual(want, got))
      found = found ?? tenantId;
  }
  return found;
}

/**
 * The key of the ROOFTOP conversation opened from a group conversation. It is the only link
 * between the two: a keyed hash the server recomputes each turn, stored nowhere in the group
 * tenant. It is not a valid widget conversation id (`cv1.…`), so no widget token — rooftop or
 * group — can address the rooftop conversation directly.
 */
export function ownerConversationKey(
  key: Buffer,
  p: {
    groupSiteTenantId: string;
    groupConversationKey: string;
    ownerTenantId: string;
  },
): string {
  const h = createHmac('sha256', key)
    .update(
      ['conv', p.groupSiteTenantId, p.groupConversationKey, p.ownerTenantId]
        .map((x) => `${x.length}:${x}`)
        .join('|'),
    )
    .digest()
    .subarray(0, 24)
    .toString('base64url');
  return `grp1.${h}`;
}
