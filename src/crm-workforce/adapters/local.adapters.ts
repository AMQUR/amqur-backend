import { isProductionTier } from '../../config/deployment-tier';
import {
  AdapterBlockedError,
  AdapterHealth,
  AdapterScope,
  capabilitiesFrom,
  CrmAdapter,
  CrmLeadRecord,
  CrmOperation,
  VerifyResult,
  WriteReceipt,
  WriteRequest,
} from './crm-adapter';

const READS: CrmOperation[] = [
  'lead.list',
  'lead.read',
  'lead.owner.read',
  'communication.history.read',
  'communication.preferences.read',
  'followup.tasks.read',
  'vehicle.interest.read',
  'appointment.status.read',
  'pipeline.status.read',
];

/**
 * Dealership data export (CSV) — read-only. Records are pushed in by an authorized manager's
 * upload (see export-import.ts), so there is nothing to pull and nothing to write.
 */
export class ExportImportAdapter implements CrmAdapter {
  readonly key = 'export_import';
  readonly label = 'Dealership CRM export (read-only import)';
  readonly requiresAuthorization = true;
  capabilities() {
    return capabilitiesFrom('NOT TESTED', READS, {}, 'export_is_read_only');
  }
  async health(): Promise<AdapterHealth> {
    return { status: 'READY', reason: 'manual_upload' };
  }
  async listLeads(): Promise<CrmLeadRecord[]> {
    return [];
  }
  async executeWrite(req: WriteRequest): Promise<WriteReceipt> {
    throw new AdapterBlockedError(req.operation, 'export_is_read_only');
  }
  async verifyWrite(): Promise<VerifyResult> {
    return { state: 'UNKNOWN', detail: 'export_is_read_only' };
  }
}

/**
 * Employee-assisted workflow. The workforce prepares the draft; an employee sends it (or adds
 * the note / books the appointment) in the CRM themselves and confirms. The result is recorded
 * as STAFF_CONFIRMED — a person's statement — never as system-VERIFIED.
 */
export class ManualAssistAdapter implements CrmAdapter {
  readonly key = 'manual_assist';
  readonly label = 'Employee-assisted (staff acts in the CRM)';
  readonly requiresAuthorization = false;
  capabilities() {
    return capabilitiesFrom(
      'NOT TESTED',
      [],
      {},
      'employee_performs_this_in_the_crm',
    );
  }
  async health(): Promise<AdapterHealth> {
    return { status: 'READY', reason: 'no_system_connection' };
  }
  async listLeads(): Promise<CrmLeadRecord[]> {
    return [];
  }
  async executeWrite(req: WriteRequest): Promise<WriteReceipt> {
    throw new AdapterBlockedError(
      req.operation,
      'employee_performs_this_in_the_crm',
    );
  }
  async verifyWrite(): Promise<VerifyResult> {
    return { state: 'UNKNOWN', detail: 'employee_performs_this_in_the_crm' };
  }
}

/**
 * Synthetic fixture CRM — DEMO only, refused in the production tier. It is a small in-memory
 * CRM used by tests and local demos: writes land in its own store and `verifyWrite` reads them
 * back, and failure modes (uncertain result, rejection, lost write) can be injected to prove
 * the action pipeline handles them. Every record is `synthetic: true, verified: false`.
 */
export type FixtureFault =
  | 'none'
  | 'uncertain_but_written'
  | 'uncertain_not_written'
  | 'reject'
  | 'accepted_but_lost';

export class FixtureCrmAdapter implements CrmAdapter {
  readonly key = 'fixture';
  readonly label = 'Synthetic fixture CRM (demo data)';
  readonly requiresAuthorization = false;

  private leads = new Map<string, CrmLeadRecord[]>();
  private writes = new Map<string, { req: WriteRequest; at: string }>();
  fault: FixtureFault = 'none';
  executeCalls = 0;

  private k(s: AdapterScope) {
    return `${s.tenantId}:${s.locationId}`;
  }
  private refuseInProduction(op: CrmOperation) {
    if (isProductionTier())
      throw new AdapterBlockedError(
        op,
        'fixture_adapter_refused_in_production',
      );
  }

  seed(scope: AdapterScope, records: CrmLeadRecord[]) {
    this.leads.set(
      this.k(scope),
      records.map((r) => ({ ...r, synthetic: true, verified: false })),
    );
  }
  reset() {
    this.leads.clear();
    this.writes.clear();
    this.fault = 'none';
    this.executeCalls = 0;
  }
  writesFor(scope: AdapterScope) {
    return [...this.writes.values()].filter(
      (w) =>
        w.req.tenantId === scope.tenantId &&
        w.req.locationId === scope.locationId,
    );
  }

  capabilities() {
    const demo = { status: 'DEMO' as const };
    return capabilitiesFrom('DEMO', READS, {
      'message.sms.send': demo,
      'message.email.send': demo,
      'note.add': demo,
      'followup.task.create': demo,
    });
  }
  async health(): Promise<AdapterHealth> {
    return isProductionTier()
      ? { status: 'BLOCKED', reason: 'fixture_adapter_refused_in_production' }
      : { status: 'READY', reason: 'synthetic_data' };
  }
  async listLeads(scope: AdapterScope): Promise<CrmLeadRecord[]> {
    this.refuseInProduction('lead.list');
    return this.leads.get(this.k(scope)) ?? [];
  }
  async executeWrite(req: WriteRequest): Promise<WriteReceipt> {
    this.refuseInProduction(req.operation);
    this.executeCalls += 1;
    const store = () =>
      this.writes.set(req.idempotencyKey, {
        req,
        at: new Date().toISOString(),
      });
    // The fixture CRM is itself idempotent on the key, like a well-behaved provider.
    if (this.writes.has(req.idempotencyKey))
      return {
        outcome: 'ACCEPTED',
        externalRef: `FX-${req.idempotencyKey.slice(0, 12)}`,
      };
    switch (this.fault) {
      case 'reject':
        return {
          outcome: 'REJECTED',
          detail: 'fixture_rejected',
          permanent: true,
        };
      case 'uncertain_but_written':
        store();
        return { outcome: 'UNCERTAIN', detail: 'fixture_timeout_after_submit' };
      case 'uncertain_not_written':
        return {
          outcome: 'UNCERTAIN',
          detail: 'fixture_timeout_before_submit',
        };
      case 'accepted_but_lost':
        return {
          outcome: 'ACCEPTED',
          externalRef: null,
          detail: 'fixture_accepted',
        };
      default:
        store();
        return {
          outcome: 'ACCEPTED',
          externalRef: `FX-${req.idempotencyKey.slice(0, 12)}`,
        };
    }
  }
  async verifyWrite(req: WriteRequest): Promise<VerifyResult> {
    const w = this.writes.get(req.idempotencyKey);
    return w
      ? {
          state: 'VERIFIED',
          externalRef: `FX-${req.idempotencyKey.slice(0, 12)}`,
          observedAt: w.at,
        }
      : { state: 'NOT_FOUND' };
  }
}
