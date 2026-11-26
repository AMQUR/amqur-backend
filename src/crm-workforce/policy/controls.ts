import {
  Department,
  MODE_RANK,
  OperatingMode,
  WorkflowKey,
  envOn,
} from '../crm-workforce.types';

/**
 * Kill switches and operating modes — pure, deterministic, no model involved.
 *
 * Path for one piece of work: GLOBAL → TENANT → LOCATION → DEPARTMENT → WORKFLOW (+ SALESPERSON).
 *   - `halted` on ANY row of the path halts the work.
 *   - the effective mode is the LEAST autonomous mode stated on the path; a rooftop whose
 *     LOCATION row is missing or states no mode is OBSERVE (a rooftop must be configured
 *     explicitly — nothing is inherited into existence).
 *   - external sending needs the LOCATION row to say yes explicitly, no row on the path to
 *     say no, and both process switches. It starts off everywhere.
 *   - a row that only carries a kill switch states no mode and no send opinion, so releasing
 *     the switch restores exactly what was configured before.
 */
export type ControlRow = {
  scope:
    | 'GLOBAL'
    | 'TENANT'
    | 'LOCATION'
    | 'DEPARTMENT'
    | 'WORKFLOW'
    | 'SALESPERSON';
  scopeKey: string;
  halted: boolean;
  /** null = no opinion (a row that only carries a kill switch or a pause). */
  mode: OperatingMode | null;
  externalSendEnabled: boolean | null;
  authorization?: unknown;
  reason?: string | null;
};

export type ControlTarget = {
  tenantId: string;
  locationId: string;
  department: Department;
  workflowKey: WorkflowKey;
  assignedTo?: string | null;
  /** The agent doing the work; an individual agent can be paused (`agent:<key>` workflow row). */
  agentKey?: string | null;
};

export const scopeKeys = {
  global: () => 'GLOBAL',
  tenant: (t: string) => `T:${t}`,
  location: (t: string, l: string) => `L:${t}:${l}`,
  department: (t: string, l: string, d: Department) => `D:${t}:${l}:${d}`,
  workflow: (t: string, l: string, w: string) => `W:${t}:${l}:${w}`,
  salesperson: (t: string, l: string, name: string) =>
    `S:${t}:${l}:${name.trim().toLowerCase()}`,
};

export function pathKeys(t: ControlTarget): string[] {
  const keys = [
    scopeKeys.global(),
    scopeKeys.tenant(t.tenantId),
    scopeKeys.location(t.tenantId, t.locationId),
    scopeKeys.department(t.tenantId, t.locationId, t.department),
    scopeKeys.workflow(t.tenantId, t.locationId, t.workflowKey),
  ];
  if (t.agentKey)
    keys.push(
      scopeKeys.workflow(t.tenantId, t.locationId, `agent:${t.agentKey}`),
    );
  if (t.assignedTo?.trim())
    keys.push(scopeKeys.salesperson(t.tenantId, t.locationId, t.assignedTo));
  return keys;
}

export type EffectiveControl = {
  processEnabled: boolean;
  halted: boolean;
  haltedBy: string[];
  mode: OperatingMode;
  externalSendAllowed: boolean;
  /** Why external sending is not allowed (empty when it is). */
  externalSendBlocks: string[];
  /** The WORKFLOW row's authorization, required for CONTROLLED_AUTONOMOUS execution. */
  workflowAuthorization: unknown;
};

export function resolveControl(
  target: ControlTarget,
  rows: ControlRow[],
  env: NodeJS.ProcessEnv = process.env,
): EffectiveControl {
  const byKey = new Map(rows.map((r) => [r.scopeKey, r]));
  const keys = pathKeys(target);
  const present = keys
    .map((k) => byKey.get(k))
    .filter((r): r is ControlRow => !!r);

  const processEnabled = envOn('CRM_WORKFORCE_ENABLED', env);
  const haltedBy = present.filter((r) => r.halted).map((r) => r.scopeKey);
  if (envOn('CRM_WORKFORCE_EMERGENCY_STOP', env))
    haltedBy.unshift('ENV:EMERGENCY_STOP');

  const locationRow = byKey.get(
    scopeKeys.location(target.tenantId, target.locationId),
  );
  let mode: OperatingMode = locationRow?.mode ?? 'OBSERVE';
  for (const r of present) {
    // SALESPERSON rows only pause; they never change the mode.
    if (r.scope === 'SALESPERSON' || r.mode === null) continue;
    if (MODE_RANK[r.mode] < MODE_RANK[mode]) mode = r.mode;
  }

  const externalSendBlocks: string[] = [];
  if (!processEnabled) externalSendBlocks.push('process_switch_off');
  if (!envOn('CRM_WORKFORCE_EXTERNAL_SEND_ENABLED', env))
    externalSendBlocks.push('external_send_env_off');
  if (haltedBy.length) externalSendBlocks.push('halted');
  if (!locationRow) externalSendBlocks.push('location_not_configured');
  else if (locationRow.externalSendEnabled !== true)
    externalSendBlocks.push(`send_disabled:${locationRow.scopeKey}`);
  for (const r of present) {
    if (r.scope === 'SALESPERSON' || r === locationRow) continue;
    if (r.externalSendEnabled === false)
      externalSendBlocks.push(`send_disabled:${r.scopeKey}`);
  }
  if (mode === 'OBSERVE' || mode === 'ASSIST')
    externalSendBlocks.push(`mode_${mode.toLowerCase()}`);

  const wfRow = byKey.get(
    scopeKeys.workflow(target.tenantId, target.locationId, target.workflowKey),
  );
  if (
    mode === 'CONTROLLED_AUTONOMOUS' &&
    !isCompleteAuthorization(wfRow?.authorization)
  )
    externalSendBlocks.push('workflow_not_authorized');

  return {
    processEnabled,
    halted: haltedBy.length > 0,
    haltedBy,
    mode,
    externalSendAllowed: externalSendBlocks.length === 0,
    externalSendBlocks,
    workflowAuthorization: wfRow?.authorization ?? null,
  };
}

/**
 * A recorded permit for one workflow to run without per-message approval. Every field is
 * required; a permit that leaves any of them open is not a permit.
 */
export type WorkflowAuthorization = {
  /** Reference to the signed authorization (document id / ticket). */
  documentRef: string;
  authorizedBy: string;
  authorizedAt: string;
  /** The CRM connection the workflow may act through (the connector's adapter key). */
  account: string;
  department: 'SALES' | 'SERVICE' | 'PARTS';
  /** The single operation allowed, e.g. "message.sms.send". */
  operation: string;
  /** Plain description of the customer population. */
  audience: string;
  channels: string[];
  /** Consent that must be on record, e.g. "CONVERSATIONAL" or "MARKETING". */
  consentRequired: string;
  /** Most messages one customer may receive from this workflow per week. */
  maxPerCustomerPerWeek: number;
  /** Most messages this workflow may send per day at this rooftop. */
  dailyLimit: number;
  /** Local dealership time, "HH:MM". */
  window: { start: string; end: string };
  /** What must go to a person instead. */
  escalation: string;
  /** Permits are time-bounded: an expiry is mandatory. */
  expiresAt: string;
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const hhmmToMin = (s: string) =>
  Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

export function isCompleteAuthorization(
  a: unknown,
  now = new Date(),
): a is WorkflowAuthorization {
  if (!a || typeof a !== 'object') return false;
  const x = a as Record<string, unknown>;
  const str = (k: string) =>
    typeof x[k] === 'string' && (x[k] as string).trim().length > 0;
  for (const k of [
    'documentRef',
    'authorizedBy',
    'authorizedAt',
    'account',
    'operation',
    'audience',
    'consentRequired',
    'escalation',
    'expiresAt',
  ])
    if (!str(k)) return false;
  if (!['SALES', 'SERVICE', 'PARTS'].includes(x.department as string))
    return false;
  if (
    !Array.isArray(x.channels) ||
    x.channels.length === 0 ||
    !x.channels.every((c) => c === 'SMS' || c === 'EMAIL')
  )
    return false;
  const pos = (k: string, max: number) =>
    typeof x[k] === 'number' &&
    Number.isInteger(x[k]) &&
    (x[k] as number) > 0 &&
    (x[k] as number) <= max;
  if (!pos('dailyLimit', 5000) || !pos('maxPerCustomerPerWeek', 7))
    return false;
  const w = x.window as Record<string, unknown> | undefined;
  if (
    !w ||
    typeof w.start !== 'string' ||
    typeof w.end !== 'string' ||
    !HHMM.test(w.start) ||
    !HHMM.test(w.end) ||
    hhmmToMin(w.start) >= hhmmToMin(w.end)
  )
    return false;
  const exp = new Date(x.expiresAt as string).getTime();
  if (!Number.isFinite(exp) || exp <= now.getTime()) return false;
  // No open-ended permits: at most 90 days from when it was granted.
  const granted = new Date(x.authorizedAt as string).getTime();
  if (!Number.isFinite(granted) || exp - granted > 90 * 86_400_000)
    return false;
  return true;
}
