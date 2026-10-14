import type {
  CrmLeadInput,
  CrmLeadResult,
  CrmCustomer,
  CrmActivityInput,
} from '../core/crm.provider';

/**
 * TEST-ONLY sanitized contract fixture used to exercise idempotency / mapping logic in unit
 * tests. It is not registered in any Nest module and refuses to run outside NODE_ENV=test,
 * so fixture IDs can never be persisted as real CRM identifiers.
 */
export class TekionContractFixture {
  readonly providerId = 'tekion_fixture';
  private readonly leads = new Map<string, CrmLeadResult>();
  private readonly customers = new Map<string, CrmCustomer>();

  constructor() {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('TekionContractFixture is test-only');
    }
  }

  async createOrUpdateLead(p: CrmLeadInput): Promise<CrmLeadResult> {
    const existing = this.leads.get(p.idempotencyKey);
    if (existing) return { ...existing, duplicated: true };
    const key =
      p.email?.toLowerCase() || p.phone?.replace(/\D/g, '') || p.idempotencyKey;
    let cust = this.customers.get(`${p.tenantId}:${key}`);
    if (!cust) {
      cust = {
        externalId: `fixture-cust-${this.customers.size + 1}`,
        firstName: p.firstName,
        email: p.email,
        phone: p.phone,
        source: 'fixture',
      };
      this.customers.set(`${p.tenantId}:${key}`, cust);
    }
    const res: CrmLeadResult = {
      externalLeadId: `fixture-lead-${this.leads.size + 1}`,
      externalCustomerId: cust.externalId,
      duplicated: false,
      provider: this.providerId,
    };
    this.leads.set(p.idempotencyKey, res);
    return res;
  }

  async appendActivity(_p: CrmActivityInput) {
    return { ok: true };
  }
}
