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

export type WorkflowAuthorization = {
  documentRef: string;
  authorizedBy: string;
  authorizedAt: string;
  audience: string;
  channels: string[];
  dailyLimit: number;
  window: { start: string; end: string };
  expiresAt?: string;
};

/** Customer-facing autonomy needs workflow, audience, channel, limits and window — all of them. */
export function isCompleteAuthorization(
  a: unknown,
  now = new Date(),
): a is WorkflowAuthorization {
  if (!a || typeof a !== 'object') return false;
  const x = a as Record<string, unknown>;
  const str = (k: string) =>
    typeof x[k] === 'string' && (x[k] as string).trim().length > 0;
  if (
    !str('documentRef') ||
    !str('authorizedBy') ||
    !str('authorizedAt') ||
    !str('audience')
  )
    return false;
  if (!Array.isArray(x.channels) || x.channels.length === 0) return false;
  if (typeof x.dailyLimit !== 'number' || !(x.dailyLimit > 0)) return false;
  const w = x.window as Record<string, unknown> | undefined;
  if (!w || typeof w.start !== 'string' || typeof w.end !== 'string')
    return false;
  if (
    typeof x.expiresAt === 'string' &&
    new Date(x.expiresAt).getTime() <= now.getTime()
  )
    return false;
  return true;
}
