import { parseWorkflowGraph, WorkflowValidationError } from './workflow-graph';

const valid = () => ({
  version: 1,
  nodes: [
    { id: 'start', type: 'start', next: 'knowledge' },
    { id: 'knowledge', type: 'knowledge_search', limit: 3, next: 'branch' },
    {
      id: 'branch',
      type: 'branch_on_verified_sources',
      whenFound: 'end',
      whenMissing: 'review',
    },
    { id: 'end', type: 'end' },
    {
      id: 'review',
      type: 'human_review',
      reason: 'Missing verified information',
    },
  ],
});

describe('WorkflowGraph validation', () => {
  it('accepts a bounded acyclic knowledge workflow', () => {
    expect(parseWorkflowGraph(valid()).nodes).toHaveLength(5);
  });

  it('rejects arbitrary code/HTTP tools', () => {
    const graph = valid();
    graph.nodes[1] = {
      id: 'knowledge',
      type: 'http_request',
      next: 'branch',
    } as (typeof graph.nodes)[number];
    expect(() => parseWorkflowGraph(graph)).toThrow(WorkflowValidationError);
  });

  it('rejects cycles', () => {
    const graph = valid();
    graph.nodes[2] = {
      id: 'branch',
      type: 'branch_on_verified_sources',
      whenFound: 'knowledge',
      whenMissing: 'review',
    };
    expect(() => parseWorkflowGraph(graph)).toThrow(/Cycle detected/);
  });

  it('rejects unreachable nodes', () => {
    const graph = valid();
    graph.nodes.push({ id: 'unused', type: 'end' });
    expect(() => parseWorkflowGraph(graph)).toThrow(/reachable/);
  });

  it('rejects missing nodes and duplicate ids', () => {
    const graph = valid();
    graph.nodes[0] = { id: 'start', type: 'start', next: 'absent' };
    expect(() => parseWorkflowGraph(graph)).toThrow(/missing node/);
    const duplicate = valid();
    duplicate.nodes[3] = { id: 'review', type: 'end' };
    expect(() => parseWorkflowGraph(duplicate)).toThrow(/Duplicate node/);
  });

  it('rejects excessive result limits and unexpected fields', () => {
    const graph = valid();
    graph.nodes[1] = {
      id: 'knowledge',
      type: 'knowledge_search',
      limit: 100,
      next: 'branch',
    };
    expect(() => parseWorkflowGraph(graph)).toThrow(/between 1 and 5/);
    const extra = valid();
    expect(() => parseWorkflowGraph({ ...extra, apiKey: 'never' })).toThrow(
      /unsupported field/,
    );
  });

  const withTool = (node: Record<string, unknown>) => ({
    version: 1,
    nodes: [
      { id: 'start', type: 'start', next: 'tool' },
      { id: 'tool', type: 'tool_action', next: 'end', ...node },
      { id: 'end', type: 'end' },
    ],
  });
  const note = {
    tool: 'crm.note.add',
    fields: { leadId: 'l1', note: 'Follow up' },
  };

  it('accepts a consent-free catalog tool_action node', () => {
    expect(parseWorkflowGraph(withTool(note)).nodes[1]).toMatchObject({
      type: 'tool_action',
      tool: 'crm.note.add',
    });
  });

  it('rejects unknown tools, consent-required tools, bad fields and extra keys', () => {
    expect(() =>
      parseWorkflowGraph(withTool({ ...note, tool: 'shell.exec' })),
    ).toThrow(/not in the catalog/);
    expect(() =>
      parseWorkflowGraph(
        withTool({
          tool: 'message.send',
          fields: { leadId: 'l1', channel: 'SMS', body: 'hi' },
        }),
      ),
    ).toThrow(/requires customer consent/);
    expect(() =>
      parseWorkflowGraph(withTool({ ...note, fields: { leadId: 'l1' } })),
    ).toThrow(/Missing field/);
    expect(() =>
      parseWorkflowGraph(
        withTool({ ...note, fields: { leadId: 'l1', note: 'x', extra: 'y' } }),
      ),
    ).toThrow(/Unknown field/);
    expect(() =>
      parseWorkflowGraph(withTool({ ...note, consentRef: 'c1' })),
    ).toThrow(/unsupported field/);
  });
});
