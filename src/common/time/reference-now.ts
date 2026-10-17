/**
 * Wall clock for chat, scheduling, and date phrases. In test, defaults to a fixed
 * Tuesday (2026-10-13 10:00 America/Chicago) so "tomorrow" e2e stays on a weekday.
 */
export function referenceNow(): Date {
  const pinned = process.env.CHAT_REFERENCE_NOW?.trim();
  if (process.env.NODE_ENV === 'test') {
    return new Date(pinned || '2026-10-13T15:00:00.000Z');
  }
  if (pinned) return new Date(pinned);
  return new Date();
}
