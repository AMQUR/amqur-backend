/** Shared freshness rules for inventory truth messaging. */
export type FreshnessInput = {
  lastSeenAt?: string | null;
  freshnessState?: 'FRESH' | 'DEGRADED' | 'STALE' | 'UNAVAILABLE' | null;
};

export function inventoryFreshnessDisclaimer(
  vehicles: FreshnessInput[],
  nowMs = Date.now(),
): string {
  if (vehicles.some((v) => v.freshnessState === 'UNAVAILABLE')) {
    return 'Live inventory availability could not be confirmed. I will not claim this vehicle is available — ask our team to verify.';
  }
  if (vehicles.some((v) => v.freshnessState === 'STALE')) {
    return 'Inventory data may be stale. Please ask us to re-check live availability before you visit.';
  }
  const staleMs = 24 * 60 * 60 * 1000;
  const anyStale = vehicles.some((v) => {
    if (v.freshnessState === 'DEGRADED') return true;
    if (!v.lastSeenAt) return true;
    const t = Date.parse(v.lastSeenAt);
    return !Number.isFinite(t) || nowMs - t > staleMs;
  });
  return anyStale
    ? 'Some listings may be up to a day behind the latest feed. Ask us to re-check live availability before you visit.'
    : 'Availability and pricing come from current dealership inventory records — not AI guesses.';
}
