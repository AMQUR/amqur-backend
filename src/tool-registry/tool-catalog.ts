import { createHash } from 'crypto';

export type ToolRole = 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER';

type StringField = {
  type: 'string';
  min?: number;
  max: number;
  oneOf?: readonly string[];
  /** Free text: masked before persistence and before it is shown to an approver. */
  redact?: boolean;
  optional?: boolean;
};

export type ToolDefinition = {
  name: string;
  version: number;
  description: string;
  /** Every catalog tool is a write: nothing runs without an independent approval. */
  access: 'WRITE';
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  requiresCustomerConsent: boolean;
  proposerRoles: readonly ToolRole[];
  approverRoles: readonly ToolRole[];
  fields: Record<string, StringField>;
};

const ALL: readonly ToolRole[] = ['SUPER_ADMIN', 'ADMIN', 'MANAGER'];

/** Typed, versioned tool catalog. Providers behind these tools are MOCKS in this phase. */
export const TOOL_CATALOG: readonly ToolDefinition[] = [
  {
    name: 'crm.note.add',
    version: 1,
    description: 'Add an internal note to a lead (mock provider).',
    access: 'WRITE',
    risk: 'LOW',
    requiresCustomerConsent: false,
    proposerRoles: ALL,
    approverRoles: ALL,
    fields: {
      leadId: { type: 'string', min: 1, max: 64 },
      note: { type: 'string', min: 1, max: 1000, redact: true },
    },
  },
  {
    name: 'appointment.request',
    version: 1,
    description: 'Request an appointment slot for a lead (mock provider).',
    access: 'WRITE',
    risk: 'MEDIUM',
    requiresCustomerConsent: true,
    proposerRoles: ALL,
    approverRoles: ALL,
    fields: {
      leadId: { type: 'string', min: 1, max: 64 },
      startsAt: { type: 'string', min: 10, max: 40 },
      notes: { type: 'string', max: 300, redact: true, optional: true },
    },
  },
  {
    name: 'message.send',
    version: 1,
    description: 'Send an SMS or email to a customer (mock provider).',
    access: 'WRITE',
    risk: 'HIGH',
    requiresCustomerConsent: true,
    proposerRoles: ALL,
    approverRoles: ['SUPER_ADMIN', 'ADMIN'],
    fields: {
      leadId: { type: 'string', min: 1, max: 64 },
      channel: { type: 'string', max: 5, oneOf: ['SMS', 'EMAIL'] },
      body: { type: 'string', min: 1, max: 500, redact: true },
    },
  },
];

export class ToolInputError extends Error {}

export function findTool(name: string): ToolDefinition | undefined {
  return TOOL_CATALOG.find((t) => t.name === name);
}

/** Same masking as workflow runs: emails, VIN-like ids, phone-like and long digit runs. */
export function maskFreeText(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b[A-HJ-NPR-Z0-9]{17}\b/gi, '[vin]')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, '[number]')
    .replace(/\d{6,}/g, '[number]');
}

/** Exact-key validation; unknown keys, wrong types and out-of-range values are rejected. */
export function validateToolInput(
  tool: ToolDefinition,
  raw: unknown,
): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new ToolInputError('Input must be an object');
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input))
    if (!(key in tool.fields))
      throw new ToolInputError(`Unknown field: ${key.slice(0, 40)}`);
  const out: Record<string, string> = {};
  for (const [key, spec] of Object.entries(tool.fields)) {
    const value = input[key];
    if (value === undefined || value === null) {
      if (spec.optional) continue;
      throw new ToolInputError(`Missing field: ${key}`);
    }
    if (typeof value !== 'string')
      throw new ToolInputError(`Field ${key} must be a string`);
    const v = value.trim();
    if (v.length < (spec.min ?? 0) || v.length > spec.max)
      throw new ToolInputError(`Field ${key} has an invalid length`);
    if (spec.oneOf && !spec.oneOf.includes(v))
      throw new ToolInputError(`Field ${key} has an invalid value`);
    out[key] = spec.redact ? maskFreeText(v) : v;
  }
  if (
    tool.name === 'appointment.request' &&
    Number.isNaN(Date.parse(out.startsAt))
  )
    throw new ToolInputError('Field startsAt must be an ISO date');
  return out;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value as object)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value);
}

/** Approval is bound to exactly this value: tool, version, rooftop, redacted input, consent ref. */
export function actionChecksum(a: {
  toolName: string;
  toolVersion: number;
  locationId: string | null;
  input: unknown;
  consentRef: string | null;
}): string {
  return createHash('sha256').update(canonical(a)).digest('hex');
}
