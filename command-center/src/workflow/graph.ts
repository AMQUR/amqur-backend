/**
 * Client-side model of the Workflow Lab graph (schema v1). The server remains authoritative
 * (parseWorkflowGraph); these checks exist so authors get immediate, node-level feedback.
 * Keep node types/limits in step with src/workflow-lab/workflow-graph.ts.
 */
export type WfNode =
  | { id: string; type: 'start'; next: string }
  | { id: string; type: 'knowledge_search'; next: string; limit: number }
  | { id: string; type: 'branch_on_verified_sources'; whenFound: string; whenMissing: string }
  | { id: string; type: 'human_review'; reason: string }
  | { id: string; type: 'end' };
export type WfGraph = { version: 1; nodes: WfNode[] };
export type NodeType = WfNode['type'];

export const MAX_NODES = 24;
export const VALID_ID = /^[a-z][a-z0-9_-]{0,39}$/;

export const NODE_LABEL: Record<NodeType, string> = {
  start: 'Start',
  knowledge_search: 'Search published knowledge',
  branch_on_verified_sources: 'Branch: verified sources found?',
  human_review: 'Human review (stops here)',
  end: 'End',
};

export type Issue = { nodeId: string | null; message: string };

export function outgoing(n: WfNode): string[] {
  switch (n.type) {
    case 'start':
    case 'knowledge_search':
      return [n.next];
    case 'branch_on_verified_sources':
      return [n.whenFound, n.whenMissing];
    default:
      return [];
  }
}

export function validateGraph(g: WfGraph): Issue[] {
  const issues: Issue[] = [];
  const add = (nodeId: string | null, message: string) => issues.push({ nodeId, message });
  if (g.nodes.length < 2 || g.nodes.length > MAX_NODES) add(null, `A workflow needs 2-${MAX_NODES} nodes.`);
  const byId = new Map<string, WfNode>();
  for (const n of g.nodes) {
    if (!VALID_ID.test(n.id)) add(n.id, 'Id must start with a-z and use only lowercase letters, digits, - or _.');
    if (byId.has(n.id)) add(n.id, 'Duplicate node id.');
    byId.set(n.id, n);
    if (n.type === 'knowledge_search' && (!Number.isInteger(n.limit) || n.limit < 1 || n.limit > 5))
      add(n.id, 'Result limit must be a whole number from 1 to 5.');
    if (n.type === 'human_review' && (!n.reason.trim() || n.reason.length > 160))
      add(n.id, 'Review reason is required (max 160 characters).');
  }
  const starts = g.nodes.filter((n) => n.type === 'start');
  if (starts.length !== 1) add(null, 'Exactly one Start node is required.');
  if (!g.nodes.some((n) => n.type === 'end' || n.type === 'human_review'))
    add(null, 'Add an End or Human review node so the workflow can finish.');
  for (const n of g.nodes)
    for (const d of outgoing(n)) {
      if (!d) add(n.id, 'Choose where this step goes next.');
      else if (!byId.has(d)) add(n.id, `Points to a node that does not exist (${d}).`);
    }
  if (issues.some((i) => i.message.includes('does not exist') || i.message.includes('Duplicate'))) return issues;
  if (starts.length === 1) {
    const visited = new Set<string>();
    const active = new Set<string>();
    let cycleAt: string | null = null;
    const visit = (id: string) => {
      if (cycleAt) return;
      if (active.has(id)) {
        cycleAt = id;
        return;
      }
      if (visited.has(id)) return;
      active.add(id);
      for (const d of outgoing(byId.get(id)!)) if (byId.has(d)) visit(d);
      active.delete(id);
      visited.add(id);
    };
    visit(starts[0].id);
    if (cycleAt) add(cycleAt, 'Loops are not allowed: this step leads back to itself.');
    else for (const n of g.nodes) if (!visited.has(n.id)) add(n.id, 'Unreachable from Start.');
  }
  return issues;
}

/** Breadth-first layering for the read-only diagram; returns x/y slots per node id. */
export function layout(g: WfGraph): Map<string, { col: number; row: number }> {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const start = g.nodes.find((n) => n.type === 'start');
  const depth = new Map<string, number>();
  if (start) {
    depth.set(start.id, 0);
    const queue = [start.id];
    for (let i = 0; i < queue.length && i < 200; i += 1) {
      const id = queue[i];
      for (const d of outgoing(byId.get(id)!)) {
        if (!byId.has(d)) continue;
        const nd = (depth.get(id) ?? 0) + 1;
        if (nd > (depth.get(d) ?? -1) && nd <= MAX_NODES) {
          depth.set(d, nd);
          queue.push(d);
        }
      }
    }
  }
  const rows = new Map<number, number>();
  const out = new Map<string, { col: number; row: number }>();
  for (const n of g.nodes) {
    const col = depth.get(n.id) ?? 0;
    const row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    out.set(n.id, { col, row });
  }
  return out;
}

export type DiffEntry = { nodeId: string; kind: 'added' | 'removed' | 'changed'; detail?: string };

export function diffGraphs(before: WfGraph | null, after: WfGraph): DiffEntry[] {
  const b = new Map((before?.nodes ?? []).map((n) => [n.id, n]));
  const a = new Map(after.nodes.map((n) => [n.id, n]));
  const out: DiffEntry[] = [];
  for (const [id, n] of a) {
    const old = b.get(id);
    if (!old) out.push({ nodeId: id, kind: 'added', detail: NODE_LABEL[n.type] });
    else if (JSON.stringify(old) !== JSON.stringify(n)) {
      const keys = Object.keys(n).filter((k) => (n as Record<string, unknown>)[k] !== (old as Record<string, unknown>)[k]);
      out.push({ nodeId: id, kind: 'changed', detail: keys.join(', ') });
    }
  }
  for (const [id] of b) if (!a.has(id)) out.push({ nodeId: id, kind: 'removed' });
  return out;
}

export function newNode(type: NodeType, existing: WfNode[]): WfNode {
  const base = type.replace(/_/g, '-');
  let i = existing.filter((n) => n.type === type).length + 1;
  while (existing.some((n) => n.id === `${base}-${i}`)) i += 1;
  const id = `${base}-${i}`.slice(0, 40);
  switch (type) {
    case 'start':
      return { id, type, next: '' };
    case 'knowledge_search':
      return { id, type, next: '', limit: 3 };
    case 'branch_on_verified_sources':
      return { id, type, whenFound: '', whenMissing: '' };
    case 'human_review':
      return { id, type, reason: 'A dealership specialist should answer this.' };
    case 'end':
      return { id, type };
  }
}

/** Reviewed dealership starting points. Templates are drafts: they still need review to publish. */
export const TEMPLATES: Array<{ id: string; name: string; description: string; graph: WfGraph }> = [
  {
    id: 'kb-or-specialist',
    name: 'Answer from published knowledge, else a specialist',
    description: 'Looks up published, customer-visible knowledge. With no verified source, it stops for a human instead of guessing.',
    graph: {
      version: 1,
      nodes: [
        { id: 'start', type: 'start', next: 'search' },
        { id: 'search', type: 'knowledge_search', next: 'check', limit: 3 },
        { id: 'check', type: 'branch_on_verified_sources', whenFound: 'done', whenMissing: 'specialist' },
        { id: 'done', type: 'end' },
        { id: 'specialist', type: 'human_review', reason: 'No verified source found; a dealership specialist should answer.' },
      ],
    },
  },
  {
    id: 'always-human',
    name: 'Always route to a specialist',
    description: 'For topics (pricing, financing offers, trade values) that must never be answered without a person.',
    graph: {
      version: 1,
      nodes: [
        { id: 'start', type: 'start', next: 'specialist' },
        { id: 'specialist', type: 'human_review', reason: 'This topic requires a dealership specialist.' },
      ],
    },
  },
];
