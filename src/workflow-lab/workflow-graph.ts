import {
  findTool,
  ToolInputError,
  validateToolInput,
} from '../tool-registry/tool-catalog';

/**
 * AMQUR original, intentionally limited workflow DSL for safe staff previews.
 * No model calls, arbitrary HTTP, code execution, CRM mutations or scheduling.
 * `tool_action` only PROPOSES a typed catalog action into the staff approval inbox; it never
 * executes anything, and only tools that need no customer consent are allowed.
 */
export type WorkflowNode =
  | { id: string; type: 'start'; next: string }
  | { id: string; type: 'knowledge_search'; next: string; limit: number }
  | {
      id: string;
      type: 'branch_on_verified_sources';
      whenFound: string;
      whenMissing: string;
    }
  | {
      id: string;
      type: 'tool_action';
      tool: string;
      fields: Record<string, string>;
      next: string;
    }
  | { id: string; type: 'human_review'; reason: string }
  | { id: string; type: 'end' };

export type WorkflowGraph = {
  version: 1;
  nodes: WorkflowNode[];
};

export class WorkflowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowValidationError';
  }
}

const MAX_NODES = 24;
const VALID_ID = /^[a-z][a-z0-9_-]{0,39}$/;

type Dict = Record<string, unknown>;

function record(value: unknown, path: string): Dict {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new WorkflowValidationError(`${path} must be an object`);
  return value as Dict;
}

function exactKeys(obj: Dict, allowed: string[], path: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key))
      throw new WorkflowValidationError(`${path} has unsupported field ${key}`);
  }
}

function requiredString(
  obj: Dict,
  field: string,
  path: string,
  maxLength: number,
): string {
  const value = obj[field];
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength)
    throw new WorkflowValidationError(
      `${path}.${field} must be a nonempty string <= ${maxLength} chars`,
    );
  return value;
}

function parseNode(input: unknown, index: number): WorkflowNode {
  const path = `nodes[${index}]`;
  const n = record(input, path);
  const id = requiredString(n, 'id', path, 40);
  if (!VALID_ID.test(id))
    throw new WorkflowValidationError(
      `${path}.id must use lowercase a-z, digits, - or _`,
    );
  switch (n.type) {
    case 'start':
      exactKeys(n, ['id', 'type', 'next'], path);
      return { id, type: 'start', next: requiredString(n, 'next', path, 40) };
    case 'knowledge_search': {
      exactKeys(n, ['id', 'type', 'next', 'limit'], path);
      const limit = n.limit ?? 3;
      if (
        !Number.isInteger(limit) ||
        (limit as number) < 1 ||
        (limit as number) > 5
      )
        throw new WorkflowValidationError(
          `${path}.limit must be an integer between 1 and 5`,
        );
      return {
        id,
        type: 'knowledge_search',
        next: requiredString(n, 'next', path, 40),
        limit: limit as number,
      };
    }
    case 'branch_on_verified_sources':
      exactKeys(n, ['id', 'type', 'whenFound', 'whenMissing'], path);
      return {
        id,
        type: 'branch_on_verified_sources',
        whenFound: requiredString(n, 'whenFound', path, 40),
        whenMissing: requiredString(n, 'whenMissing', path, 40),
      };
    case 'tool_action': {
      exactKeys(n, ['id', 'type', 'tool', 'fields', 'next'], path);
      const toolName = requiredString(n, 'tool', path, 64);
      const tool = findTool(toolName);
      if (!tool)
        throw new WorkflowValidationError(`${path}.tool is not in the catalog`);
      if (tool.requiresCustomerConsent)
        throw new WorkflowValidationError(
          `${path}.tool requires customer consent and cannot be used in a workflow`,
        );
      const fields = record(n.fields, `${path}.fields`);
      let clean: Record<string, string>;
      try {
        clean = validateToolInput(tool, fields);
      } catch (e: unknown) {
        if (e instanceof ToolInputError)
          throw new WorkflowValidationError(`${path}.fields: ${e.message}`);
        throw e;
      }
      // Persist only the validated (trimmed, masked) values. Text that masking would alter
      // looks like personal data, so reject it rather than store or silently rewrite it.
      for (const [key, value] of Object.entries(clean)) {
        if (value !== (fields[key] as string).trim())
          throw new WorkflowValidationError(
            `${path}.fields.${key} must not contain personal data (emails, phone numbers, VINs)`,
          );
      }
      return {
        id,
        type: 'tool_action',
        tool: toolName,
        fields: clean,
        next: requiredString(n, 'next', path, 40),
      };
    }
    case 'human_review':
      exactKeys(n, ['id', 'type', 'reason'], path);
      return {
        id,
        type: 'human_review',
        reason: requiredString(n, 'reason', path, 160),
      };
    case 'end':
      exactKeys(n, ['id', 'type'], path);
      return { id, type: 'end' };
    default:
      throw new WorkflowValidationError(`${path}.type is not supported`);
  }
}

function outgoing(node: WorkflowNode): string[] {
  switch (node.type) {
    case 'start':
    case 'knowledge_search':
    case 'tool_action':
      return [node.next];
    case 'branch_on_verified_sources':
      return [node.whenFound, node.whenMissing];
    case 'human_review':
    case 'end':
      return [];
  }
}

/** Parse untrusted JSON, reject cycles/unreachable nodes/dangling edges. */
export function parseWorkflowGraph(value: unknown): WorkflowGraph {
  const graph = record(value, 'graph');
  exactKeys(graph, ['version', 'nodes'], 'graph');
  if (graph.version !== 1)
    throw new WorkflowValidationError('Only graph version 1 is supported');
  if (
    !Array.isArray(graph.nodes) ||
    graph.nodes.length < 2 ||
    graph.nodes.length > MAX_NODES
  )
    throw new WorkflowValidationError(
      `graph.nodes must contain 2-${MAX_NODES} nodes`,
    );

  const nodes = graph.nodes.map((node, i) => parseNode(node, i));
  const byId = new Map<string, WorkflowNode>();
  for (const node of nodes) {
    if (byId.has(node.id))
      throw new WorkflowValidationError(`Duplicate node: ${node.id}`);
    byId.set(node.id, node);
  }
  const starts = nodes.filter((n) => n.type === 'start');
  if (starts.length !== 1)
    throw new WorkflowValidationError('Exactly one start node is required');
  if (!nodes.some((n) => n.type === 'end' || n.type === 'human_review'))
    throw new WorkflowValidationError(
      'A terminal end or human_review node is required',
    );
  for (const node of nodes) {
    for (const dest of outgoing(node)) {
      if (!byId.has(dest))
        throw new WorkflowValidationError(
          `Node ${node.id} points to missing node ${dest}`,
        );
    }
  }

  const visited = new Set<string>();
  const active = new Set<string>();
  const visit = (id: string): void => {
    if (active.has(id))
      throw new WorkflowValidationError(`Cycle detected at ${id}`);
    if (visited.has(id)) return;
    active.add(id);
    for (const dest of outgoing(byId.get(id)!)) visit(dest);
    active.delete(id);
    visited.add(id);
  };
  visit(starts[0].id);
  if (visited.size !== nodes.length)
    throw new WorkflowValidationError(
      'Every node must be reachable from start',
    );
  return { version: 1, nodes };
}
