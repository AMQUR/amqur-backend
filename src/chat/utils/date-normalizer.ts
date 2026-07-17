export function normalizeDate(
  input: string,
  timezone = 'America/Chicago',
): string | undefined {
  const now = new Date(
    new Date().toLocaleString('en-US', { timeZone: timezone }),
  );

  const lower = input.toLowerCase();

  // today
  if (lower === 'today') {
    return iso(now);
  }

  // tomorrow
  if (lower === 'tomorrow') {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return iso(d);
  }

  // weekdays
  const weekdays = [
    'sunday',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
  ];

  const idx = weekdays.indexOf(lower);
  if (idx !== -1) {
    const d = new Date(now);
    const diff = (idx + 7 - d.getDay()) % 7 || 7;
    d.setDate(d.getDate() + diff);
    return iso(d);
  }

  // already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return input;
  }

  return undefined;
}

function iso(d: Date) {
  return d.toISOString().split('T')[0];
}
