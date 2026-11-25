import {
  AdapterBlockedError,
  AdapterHealth,
  AdapterScope,
  blockedCapabilities,
  CrmAdapter,
  CrmLeadRecord,
  VerifyResult,
  WriteReceipt,
  WriteRequest,
} from './crm-adapter';

/**
 * Tekion — authorized API (Automotive Partner Cloud).
 *
 * BLOCKED. No official specification, sandbox, scopes or credentials have been issued to AMQUR
 * (docs/TEKION_INTEGRATION.md). There is deliberately no HTTP client here and no endpoint path:
 * none may be guessed. When APC access is granted, the existing fail-closed
 * `src/integrations/tekion` provider gains its official client and this adapter delegates to it.
 */
export class TekionApiAdapter implements CrmAdapter {
  readonly key = 'tekion_api';
  readonly label = 'Tekion APC (authorized API)';
  readonly requiresAuthorization = true;
  private readonly reason = 'tekion_apc_scopes_and_spec_not_issued';

  capabilities() {
    return blockedCapabilities(this.reason);
  }
  async health(): Promise<AdapterHealth> {
    return { status: 'BLOCKED', reason: this.reason };
  }
  async listLeads(): Promise<CrmLeadRecord[]> {
    throw new AdapterBlockedError('lead.list', this.reason);
  }
  async executeWrite(req: WriteRequest): Promise<WriteReceipt> {
    throw new AdapterBlockedError(req.operation, this.reason);
  }
  async verifyWrite(): Promise<VerifyResult> {
    return { state: 'UNKNOWN', detail: this.reason };
  }
}

/**
 * Tekion — authorized browser operations (https://app.tekioncloud.com/crm/dashboard).
 *
 * DISABLED. Unattended browser access needs (1) confirmation that the dealership's Tekion
 * subscription agreement permits it and (2) written automation permission plus an approved
 * service account. Neither is on record, so this adapter contains NO browser driver, NO
 * selectors and NO session handling for Tekion — it cannot touch the CRM.
 *
 * When authorization is recorded, the driver is added behind this same contract with these
 * fixed rules (they are part of the contract, not options):
 *   - visible, supported CRM screens only; no private endpoints, no captured tokens;
 *   - no stealth plugins, no disguising automation; MFA / CAPTCHA are never bypassed —
 *     they stop the session and page an operator;
 *   - a persistent browser profile per rooftop with credentials from the secret vault;
 *   - session-health checks before every action; on expiry → status SESSION_EXPIRED, queue
 *     paused for that rooftop, safe shutdown, operator re-login;
 *   - vendor rate limits respected; every write re-read from the CRM before it is VERIFIED.
 */
export class TekionBrowserAdapter implements CrmAdapter {
  readonly key = 'tekion_browser';
  readonly label = 'Tekion CRM (authorized browser operations)';
  readonly requiresAuthorization = true;
  private readonly reason = 'written_automation_permission_not_on_record';

  capabilities() {
    return blockedCapabilities(this.reason);
  }
  async health(_scope: AdapterScope): Promise<AdapterHealth> {
    return { status: 'BLOCKED', reason: this.reason };
  }
  async listLeads(): Promise<CrmLeadRecord[]> {
    throw new AdapterBlockedError('lead.list', this.reason);
  }
  async executeWrite(req: WriteRequest): Promise<WriteReceipt> {
    throw new AdapterBlockedError(req.operation, this.reason);
  }
  async verifyWrite(): Promise<VerifyResult> {
    return { state: 'UNKNOWN', detail: this.reason };
  }
}
