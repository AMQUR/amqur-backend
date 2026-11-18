/** Cosine similarity in [-1, 1]; 0 for mismatched/empty/zero vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Parses a stored JSON embedding; returns null unless it is a finite number[]. */
export function parseStoredVector(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  for (const n of value)
    if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return value as number[];
}
