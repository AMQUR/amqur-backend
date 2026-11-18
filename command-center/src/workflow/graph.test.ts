import { describe, expect, it } from 'vitest';
import { diffGraphs, layout, newNode, TEMPLATES, validateGraph, type WfGraph } from './graph';

const ok = TEMPLATES[0].graph;
const clone = (g: WfGraph): WfGraph => JSON.parse(JSON.stringify(g));

describe('validateGraph', () => {
  it('accepts every shipped template', () => {
    for (const t of TEMPLATES) expect(validateGraph(t.graph)).toEqual([]);
  });
  it('flags dangling edges with the offending node', () => {
    const g = clone(ok);
    (g.nodes[1] as { next: string }).next = 'ghost';
    expect(validateGraph(g)).toEqual([{ nodeId: 'search', message: expect.stringContaining('does not exist') }]);
  });
  it('flags empty edges, bad limits and missing review reasons', () => {
    const g = clone(ok);
    (g.nodes[1] as { next: string; limit: number }).next = '';
    (g.nodes[1] as { limit: number }).limit = 9;
    (g.nodes[4] as { reason: string }).reason = ' ';
    const msgs = validateGraph(g).map((i) => i.message).join('|');
    expect(msgs).toMatch(/Choose where/);
    expect(msgs).toMatch(/1 to 5/);
    expect(msgs).toMatch(/reason is required/);
  });
  it('rejects cycles and unreachable nodes', () => {
    const cyc = clone(ok);
    (cyc.nodes[2] as { whenFound: string }).whenFound = 'search';
    expect(validateGraph(cyc).some((i) => /Loops/.test(i.message))).toBe(true);
    const orphan = clone(ok);
    orphan.nodes.push({ id: 'lonely', type: 'end' });
    expect(validateGraph(orphan)).toEqual([{ nodeId: 'lonely', message: 'Unreachable from Start.' }]);
  });
  it('requires exactly one start, a terminal, and bounded size', () => {
    const two = clone(ok);
    two.nodes.push({ id: 'start-2', type: 'start', next: 'done' });
    expect(validateGraph(two).some((i) => /Exactly one Start/.test(i.message))).toBe(true);
    const many = clone(ok);
    for (let i = 0; i < 25; i += 1) many.nodes.push(newNode('end', many.nodes));
    expect(validateGraph(many).some((i) => /2-24/.test(i.message))).toBe(true);
  });
  it('rejects duplicate and malformed ids', () => {
    const g = clone(ok);
    g.nodes.push({ id: 'Done!', type: 'end' });
    g.nodes.push({ id: 'done', type: 'end' });
    const msgs = validateGraph(g).map((i) => i.message).join('|');
    expect(msgs).toMatch(/Id must start/);
    expect(msgs).toMatch(/Duplicate/);
  });
});

describe('layout / diff / newNode', () => {
  it('places nodes in left-to-right columns by depth', () => {
    const l = layout(ok);
    expect(l.get('start')).toEqual({ col: 0, row: 0 });
    expect(l.get('search')?.col).toBe(1);
    expect(l.get('check')?.col).toBe(2);
    expect(l.get('done')?.col).toBe(3);
    expect(l.get('specialist')?.col).toBe(3);
    expect(l.get('done')?.row).not.toBe(l.get('specialist')?.row);
  });
  it('diffs added, removed and changed nodes', () => {
    const after = clone(ok);
    (after.nodes[1] as { limit: number }).limit = 5;
    after.nodes = after.nodes.filter((n) => n.id !== 'done');
    after.nodes.push({ id: 'extra', type: 'end' });
    const d = diffGraphs(ok, after);
    expect(d).toContainEqual({ nodeId: 'search', kind: 'changed', detail: 'limit' });
    expect(d).toContainEqual({ nodeId: 'done', kind: 'removed' });
    expect(d.find((e) => e.nodeId === 'extra')?.kind).toBe('added');
    expect(diffGraphs(null, ok)).toHaveLength(ok.nodes.length);
  });
  it('generates unique valid ids', () => {
    const a = newNode('end', ok.nodes);
    const b = newNode('end', [...ok.nodes, a]);
    expect(a.id).not.toBe(b.id);
    expect(/^[a-z][a-z0-9_-]{0,39}$/.test(b.id)).toBe(true);
  });
});
