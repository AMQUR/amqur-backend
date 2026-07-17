export function toMinutes(time: string): number {
  // "3:30 PM" → minutes since midnight
  const match = time.match(/(\d{1,2}):(\d{2})\s?(AM|PM)/i);
  if (!match) return -1;

  let hour = Number(match[1]);
  const min = Number(match[2]);
  const suffix = match[3].toUpperCase();

  if (suffix === 'PM' && hour !== 12) hour += 12;
  if (suffix === 'AM' && hour === 12) hour = 0;

  return hour * 60 + min;
}
