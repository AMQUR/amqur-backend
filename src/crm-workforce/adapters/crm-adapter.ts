import { Channel, Department } from '../crm-workforce.types';

/**
 * Interchangeable CRM adapter contract.
 *
 * Every operation is declared as READ_ONLY, DRAFT_ONLY or EXTERNAL and carries its own
 * capability status. There is no single "CRM connected" badge: an adapter that can read leads
 * says nothing about whether it can send a message or book an appointment.
 */
export type SideEffect = 'READ_ONLY' | 'DRAFT_ONLY' | 'EXTERNAL';

export type CapabilityStatus =
  | 'LIVE VERIFIED'
  | 'SANDBOX VERIFIED'
  | 'DEMO'
  | 'BLOCKED'
  | 'NOT TESTED';

export type CrmOperation =
  | 'lead.list'
  | 'lead.read'
  | 'lead.owner.read'
  | 'communication.history.read'
  | 'communication.preferences.read'
  | 'followup.tasks.read'
  | 'vehicle.interest.read'
  | 'appointment.status.read'
  | 'pipeline.status.read'
  | 'message.sms.prepare'
  | 'message.email.prepare'
  | 'message.sms.send'
  | 'message.email.send'
  | 'followup.task.create'
  | 'note.add'
  | 'appointment.create'
  | 'appointment.reschedule'
  | 'escalate';

export const OPERATION_SIDE_EFFECT: Record<CrmOperation, SideEffect> = {
  'lead.list': 'READ_ONLY',
  'lead.read': 'READ_ONLY',
  'lead.owner.read': 'READ_ONLY',
  'communication.history.read': 'READ_ONLY',
  'communication.preferences.read': 'READ_ONLY',
  'followup.tasks.read': 'READ_ONLY',
  'vehicle.interest.read': 'READ_ONLY',
  'appointment.status.read': 'READ_ONLY',
  'pipeline.status.read': 'READ_ONLY',
  'message.sms.prepare': 'DRAFT_ONLY',
  'message.email.prepare': 'DRAFT_ONLY',
  'message.sms.send': 'EXTERNAL',
  'message.email.send': 'EXTERNAL',
  'followup.task.create': 'EXTERNAL',
  'note.add': 'EXTERNAL',
  'appointment.create': 'EXTERNAL',
  'appointment.reschedule': 'EXTERNAL',
  escalate: 'DRAFT_ONLY',
};

export type Capability = { status: CapabilityStatus; reason?: string };

export type CrmMessageRecord = {
  sourceRecordId: string;
  direction: 'INBOUND' | 'OUTBOUND';
  channel: 'SMS' | 'EMAIL' | 'CALL' | 'CHAT' | 'NOTE';
  authorType: 'CUSTOMER' | 'STAFF' | 'AGENT' | 'SYSTEM';
  body: string;
  occurredAt: string;
};

/** One CRM lead as an adapter returns it. Deliberately has no credit, SSN, licence or
 *  financial-document field: the workforce never reads that data. */
export type CrmLeadRecord = {
  sourceRecordId: string;
  asOf: string;
  verified: boolean;
  synthetic: boolean;
  department: Department;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  email?: string | null;
  language?: string | null;
  leadSource?: string | null;
  crmStatus?: string | null;
  assignedTo?: string | null;
  vehicleInterest?: {
    year?: number;
    make?: string;
    model?: string;
    trim?: string;
    vin?: string;
    stock?: string;
  } | null;
  createdInCrmAt?: string | null;
  hasFutureFollowUp?: boolean;
  appointmentState?:
    | 'NONE'
    | 'PROPOSED'
    | 'SCHEDULED'
    | 'MISSED'
    | 'SHOWN'
    | 'CANCELLED';
  appointmentAt?: string | null;
  visitedAt?: string | null;
  /** CRM communication preference; null = the adapter cannot read it. */
  doNotContact?: boolean | null;
  /** A person is working this conversation until this instant. */
  humanActiveUntil?: string | null;
  messages: CrmMessageRecord[];
};

export type AdapterScope = { tenantId: string; locationId: string };

export type WriteRequest = AdapterScope & {
  operation: CrmOperation;
  /** The CRM's id for the lead being written to. */
  leadSourceRecordId: string;
  idempotencyKey: string;
  channel?: Channel;
  body?: string;
  data?: Record<string, unknown>;
};

/**
 * Result of an external write. `ACCEPTED` means the adapter handed it over — NOT that it
 * happened. Only `verifyWrite` (an independent read-back) can prove a write.
 */
export type WriteReceipt =
  | { outcome: 'ACCEPTED'; externalRef: string | null; detail?: string }
  | { outcome: 'UNCERTAIN'; detail: string }
  | { outcome: 'REJECTED'; detail: string; permanent: boolean };

export type VerifyResult =
  | { state: 'VERIFIED'; externalRef: string; observedAt: string }
  | { state: 'NOT_FOUND' }
  | { state: 'UNKNOWN'; detail: string };

export type AdapterHealth = {
  status:
    | 'READY'
    | 'DISABLED'
    | 'BLOCKED'
    | 'DEGRADED'
    | 'DISCONNECTED'
    | 'SESSION_EXPIRED';
  reason?: string;
};

export class AdapterBlockedError extends Error {
  constructor(
    public readonly operation: CrmOperation,
    public readonly reason: string,
  ) {
    super(`${operation} blocked: ${reason}`);
  }
}

export interface CrmAdapter {
  readonly key: string;
  readonly label: string;
  /** Does enabling this adapter require a recorded written authorization? */
  readonly requiresAuthorization: boolean;
  capabilities(): Record<CrmOperation, Capability>;
  health(scope: AdapterScope): Promise<AdapterHealth>;
  listLeads(scope: AdapterScope): Promise<CrmLeadRecord[]>;
  executeWrite(req: WriteRequest): Promise<WriteReceipt>;
  /** Independent read-back: did this write (by idempotency key / body) reach the CRM? */
  verifyWrite(req: WriteRequest): Promise<VerifyResult>;
}

export function blockedCapabilities(
  reason: string,
): Record<CrmOperation, Capability> {
  const out = {} as Record<CrmOperation, Capability>;
  for (const op of Object.keys(OPERATION_SIDE_EFFECT) as CrmOperation[])
    out[op] = { status: 'BLOCKED', reason };
  return out;
}

export function capabilitiesFrom(
  base: CapabilityStatus,
  reads: CrmOperation[],
  overrides: Partial<Record<CrmOperation, Capability>> = {},
  blockedReason = 'not_supported_by_this_adapter',
): Record<CrmOperation, Capability> {
  const out = blockedCapabilities(blockedReason);
  for (const op of reads) out[op] = { status: base };
  out['message.sms.prepare'] = { status: base };
  out['message.email.prepare'] = { status: base };
  out.escalate = { status: base };
  return { ...out, ...overrides };
}
