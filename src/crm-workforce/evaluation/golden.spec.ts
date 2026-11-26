import { INBOUND, REPLIES, runGolden, runInbound, runReply } from './golden';

describe('CRM Workforce golden evaluation', () => {
  it('has unique ids and only synthetic contact data', () => {
    const ids = [...INBOUND, ...REPLIES].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const all = JSON.stringify([INBOUND, REPLIES]);
    expect(all).not.toMatch(/\b\d{3}[-. ]?\d{3}[-. ]?\d{4}\b/); // no phone numbers
    expect(all).not.toMatch(/@(?!example)[a-z0-9-]+\.(com|net|org)\b/i);
  });
  it.each(INBOUND.map((c) => [c.id, c] as const))('inbound %s', (_id, c) => {
    const r = runInbound(c);
    expect(r.detail).toBe('');
  });
  it.each(REPLIES.map((c) => [c.id, c] as const))('reply %s', (_id, c) => {
    const r = runReply(c);
    expect(r.detail).toBe('');
  });
  it('passes every critical case (release gate)', () => {
    const g = runGolden();
    expect(g.criticalFailed).toEqual([]);
    expect(g.criticalTotal).toBeGreaterThanOrEqual(40);
  });
});
