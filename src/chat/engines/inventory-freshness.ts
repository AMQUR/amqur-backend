/** Shared freshness rules for inventory truth messaging. */
export function inventoryFreshnessDisclaimer(
  vehicles: Array<{ lastSeenAt?: string | null }>,
  nowMs = Date.now(),
): string {
  const staleMs = 24 * 60 * 60 * 1000;
  const anyStale = vehicles.some((v) => {
    if (!v.lastSeenAt) return true;
    const t = Date.parse(v.lastSeenAt);
    return !Number.isFinite(t) || nowMs - t > staleMs;
  });
  return anyStale
    ? 'Some listings may be up to a day behind the latest feed. Ask us to re-check live availability before you visit.'
    : 'Availability and pricing come from current dealership inventory records — not AI guesses.';
}
