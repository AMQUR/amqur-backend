/**
 * The single predicate for "a real lead hand-off" in reports and readiness evidence.
 *
 * A delivery is REAL only when it was sent by the live transport (`deliveryMode = 'live'`) AND
 * on a PRODUCTION-environment route. The route's environment alone is not enough: a sandbox
 * transport (in-process sink / loopback mock) acknowledging a lead for a PRODUCTION route never
 * reached a CRM, so it must never count as accepted mail or as LIVE VERIFIED evidence.
 */
export const REAL_DELIVERY = {
  deliveryMode: 'live',
  route: { environment: 'PRODUCTION' as const },
};

/** Everything else: a SANDBOX route, or any hand-off not made by the live transport. */
export const NOT_REAL_DELIVERY = {
  OR: [
    { route: { environment: 'SANDBOX' as const } },
    { deliveryMode: null },
    { deliveryMode: { not: 'live' } },
  ],
};
