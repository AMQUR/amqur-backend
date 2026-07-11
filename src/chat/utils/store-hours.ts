export type StoreHours = {
    open: string;   // "09:00"
    close: string;  // "19:00"
};

/** Verified default hours copy for assistant (no DB) — adjust per deployment if needed. */
export function summarizeDefaultStoreHours(): string {
    return (
        'Monday–Friday 9:00 AM–7:00 PM, ' +
        'Saturday 9:00 AM–6:00 PM, Sunday closed.'
    );
}

export const DEFAULT_STORE_HOURS: Record<number, StoreHours | null> = {
    0: null, // Sunday closed
    1: { open: '09:00', close: '19:00' },
    2: { open: '09:00', close: '19:00' },
    3: { open: '09:00', close: '19:00' },
    4: { open: '09:00', close: '19:00' },
    5: { open: '09:00', close: '19:00' },
    6: { open: '09:00', close: '18:00' }, // Saturday shorter
};
