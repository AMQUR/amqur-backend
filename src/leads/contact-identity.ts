/**
 * Conservative contact identity helpers for lead matching.
 * Never invent matches across tenants. Prefer exact normalized phone/email.
 * Ambiguous multi-matches return null so a human can review — no silent merge.
 */

export function normalizeEmail(
  email: string | null | undefined,
): string | null {
  if (!email) return null;
  const e = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  return e.slice(0, 254);
}

/** Digits-only E.164-ish: keep leading country code if present; US 10-digit → +1. */
export function normalizePhone(
  phone: string | null | undefined,
): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D+/g, '');
  if (digits.length < 10 || digits.length > 15) return null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

export type IdentityMatch = {
  kind: 'email' | 'phone' | 'conversation';
  value: string;
};

/**
 * Rank match candidates. If more than one distinct lead id matches on phone
 * OR email within the tenant, treat as ambiguous (caller must not auto-merge).
 */
export function pickUniqueMatch<T extends { id: string }>(
  candidates: T[],
):
  | { status: 'MATCHED'; lead: T }
  | { status: 'NONE' }
  | { status: 'AMBIGUOUS'; ids: string[] } {
  const uniq = new Map<string, T>();
  for (const c of candidates) uniq.set(c.id, c);
  if (uniq.size === 0) return { status: 'NONE' };
  if (uniq.size > 1)
    return { status: 'AMBIGUOUS', ids: [...uniq.keys()].slice(0, 10) };
  return { status: 'MATCHED', lead: [...uniq.values()][0] };
}
