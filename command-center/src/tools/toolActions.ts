/** Types and pure helpers for the staff tool-action approval inbox (Phase 4b). No I/O. */
export type ToolRisk = 'LOW' | 'MEDIUM' | 'HIGH';
export type ToolActionStatus =
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'DENIED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'EXECUTED'
  | 'FAILED';

export type ToolCatalogEntry = {
  name: string;
  version: number | string;
  description: string;
  risk: ToolRisk;
  requiresCustomerConsent: boolean;
  proposerRoles: string[];
  approverRoles: string[];
  fields?: Record<string, { type: string; min?: number; max: number; optional?: boolean; redact?: boolean }>;
};

export type ToolCatalog = {
  enabled: boolean;
  dispatchEnabled: boolean;
  providerMode: string;
  tools: ToolCatalogEntry[];
};

export type ToolActionRow = {
  id: string;
  locationId: string | null;
  toolName: string;
  toolVersion: number | string;
  input: Record<string, unknown>;
  checksum: string;
  consentRef: string | null;
  status: ToolActionStatus;
  expiresAt: string;
  requestedByUserId: string;
  decidedByUserId: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  failureReason: string | null;
  createdAt: string;
};

export const TOOLS_BASE = '/ops/tools';

export const STATUS_FILTERS: Array<{ id: ToolActionStatus | 'ALL'; label: string }> = [
  { id: 'PENDING_APPROVAL', label: 'Awaiting approval' },
  { id: 'APPROVED', label: 'Approved' },
  { id: 'EXECUTED', label: 'Executed (mock)' },
  { id: 'DENIED', label: 'Denied' },
  { id: 'EXPIRED', label: 'Expired' },
  { id: 'CANCELLED', label: 'Cancelled' },
  { id: 'FAILED', label: 'Failed' },
  { id: 'ALL', label: 'All' },
];

export const statusLabel = (s: ToolActionStatus): string =>
  s === 'PENDING_APPROVAL' ? 'awaiting approval' : s === 'EXECUTED' ? 'executed (mock)' : s.toLowerCase();

export const riskTone = (r: ToolRisk): 'ok' | 'warn' | 'bad' => (r === 'HIGH' ? 'bad' : r === 'MEDIUM' ? 'warn' : 'ok');

export const actionTone = (s: ToolActionStatus): 'ok' | 'warn' | 'bad' | 'info' | 'neutral' =>
  s === 'PENDING_APPROVAL' ? 'warn' : s === 'APPROVED' || s === 'EXECUTED' ? 'ok' : s === 'DENIED' || s === 'FAILED' ? 'bad' : 'neutral';

export function isExpired(row: Pick<ToolActionRow, 'expiresAt'>, now = Date.now()): boolean {
  return Date.parse(row.expiresAt) <= now;
}

export type Capability = { canDecide: boolean; canCancel: boolean; reason?: string };

/**
 * UI hints only; the server enforces every rule. Mirrors them so staff see why a button is
 * missing instead of getting a 403: role must be an approver of the tool, reviewer must differ
 * from the requester, and the action must still be pending and unexpired.
 */
export function capability(
  row: ToolActionRow,
  tool: ToolCatalogEntry | undefined,
  user: { id: string; role: string },
  now = Date.now(),
): Capability {
  if (row.status !== 'PENDING_APPROVAL') return { canDecide: false, canCancel: false, reason: 'Already resolved' };
  if (isExpired(row, now)) return { canDecide: false, canCancel: false, reason: 'Expired' };
  const canCancel = row.requestedByUserId === user.id;
  if (!tool) return { canDecide: false, canCancel, reason: 'Tool is no longer in the catalog' };
  if (!tool.approverRoles.includes(user.role)) return { canDecide: false, canCancel, reason: `Needs ${tool.approverRoles.join(' / ')}` };
  if (row.requestedByUserId === user.id) return { canDecide: false, canCancel, reason: 'You requested this; another reviewer must decide' };
  return { canDecide: true, canCancel };
}

export function decisionBody(row: Pick<ToolActionRow, 'checksum'>, decision: 'APPROVE' | 'DENY', note?: string) {
  const n = note?.trim().slice(0, 300);
  return { decision, reviewedChecksum: row.checksum, ...(n ? { note: n } : {}) };
}

export function listPath(status: ToolActionStatus | 'ALL'): string {
  return status === 'ALL' ? `${TOOLS_BASE}/actions` : `${TOOLS_BASE}/actions?status=${status}`;
}

/** Input is already masked server-side; this only orders and stringifies it for display. */
export function inputEntries(input: Record<string, unknown>): Array<[string, string]> {
  return Object.keys(input)
    .sort()
    .map((k) => [k, typeof input[k] === 'string' ? (input[k] as string) : JSON.stringify(input[k])] as [string, string]);
}

export function expiryText(row: Pick<ToolActionRow, 'expiresAt' | 'status'>, now = Date.now()): string {
  if (row.status !== 'PENDING_APPROVAL') return '';
  const ms = Date.parse(row.expiresAt) - now;
  if (ms <= 0) return 'expired';
  const h = Math.floor(ms / 3_600_000);
  return h >= 1 ? `expires in ${h}h` : `expires in ${Math.max(1, Math.floor(ms / 60_000))}m`;
}

/** Tools a workflow may propose: consent-free only (the server enforces this too). */
export const workflowTools = (catalog: Pick<ToolCatalog, 'tools'> | null): ToolCatalogEntry[] =>
  (catalog?.tools ?? []).filter((t) => !t.requiresCustomerConsent);
