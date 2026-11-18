import { cosineSimilarity, parseStoredVector } from './vector-math';

describe('vector-math', () => {
  it('computes cosine similarity', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });
  it('returns 0 for mismatched, empty or zero vectors', () => {
    expect(cosineSimilarity([1], [1, 2])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
  it('rejects malformed stored vectors', () => {
    expect(parseStoredVector([1, 2])).toEqual([1, 2]);
    expect(parseStoredVector(null)).toBeNull();
    expect(parseStoredVector([])).toBeNull();
    expect(parseStoredVector([1, 'x'])).toBeNull();
    expect(parseStoredVector([1, NaN])).toBeNull();
    expect(parseStoredVector({ a: 1 })).toBeNull();
  });
});
