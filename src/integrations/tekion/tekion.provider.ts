import { Injectable, Logger } from '@nestjs/common';
import type {
  CrmActivityInput,
  CrmCustomer,
  CrmLeadInput,
  CrmLeadResult,
  CrmProvider,
} from '../core/crm.provider';
import type {
  DmsProvider,
  RepairOrderStatus,
  ServiceAppointmentRequest,
  ServiceAppointmentResult,
} from '../core/dms.provider';

/**
 * Tekion adapter skeleton + mock.
 *
 * LIVE credentials and official partner API specs are REQUIRED before
 * enabling IntegrationConnection.liveReady / enabled. This class never
 * invents Tekion endpoints or claims live success.
 */
@Injectable()
export class TekionProvider implements CrmProvider, DmsProvider {
  readonly providerId = 'tekion';
  private readonly logger = new Logger(TekionProvider.name);
  private readonly mockLeads = new Map<string, CrmLeadResult>();
  private readonly mockCustomers = new Map<string, CrmCustomer>();

  /** Live HTTP client is intentionally absent until partner docs + credentials. */
  isLiveConfigured(): boolean {
    return false;
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    if (!this.isLiveConfigured()) {
      return {
        ok: true,
        detail: 'mock_mode — live Tekion disabled until credentials + contract verified',
      };
    }
    return { ok: false, detail: 'live client not implemented without official specs' };
  }

  async findCustomer(params: {
    tenantId: string;
    email?: string | null;
    phone?: string | null;
  }): Promise<CrmCustomer | null> {
    const key =
      params.email?.toLowerCase().trim() ||
      params.phone?.replace(/\D/g, '') ||
      '';
    if (!key) return null;
    return this.mockCustomers.get(`${params.tenantId}:${key}`) ?? null;
  }

  async upsertCustomer(params: CrmLeadInput): Promise<CrmCustomer> {
    const key =
      params.email?.toLowerCase().trim() ||
      params.phone?.replace(/\D/g, '') ||
      params.idempotencyKey;
    const existing = await this.findCustomer(params);
    if (existing) return existing;
    const customer: CrmCustomer = {
      externalId: `mock-tekion-cust-${key}`,
      firstName: params.firstName,
      lastName: params.lastName,
      email: params.email,
      phone: params.phone,
      source: 'tekion_mock',
    };
    this.mockCustomers.set(`${params.tenantId}:${key}`, customer);
    return customer;
  }

  async createOrUpdateLead(params: CrmLeadInput): Promise<CrmLeadResult> {
    const existing = this.mockLeads.get(params.idempotencyKey);
    if (existing) {
      return { ...existing, duplicated: true };
    }
    const customer = await this.upsertCustomer(params);
    const result: CrmLeadResult = {
      externalLeadId: `mock-tekion-lead-${params.idempotencyKey}`,
      externalCustomerId: customer.externalId,
      duplicated: false,
      provider: this.providerId,
    };
    this.mockLeads.set(params.idempotencyKey, result);
    this.logger.log(
      `Tekion mock lead upsert tenant=${params.tenantId} idem=${params.idempotencyKey}`,
    );
    return result;
  }

  async appendActivity(params: CrmActivityInput): Promise<{ ok: boolean }> {
    this.logger.debug(
      `Tekion mock activity tenant=${params.tenantId} idem=${params.idempotencyKey}`,
    );
    return { ok: true };
  }

  async getRepairOrderStatus(_params: {
    tenantId: string;
    externalId?: string;
    vin?: string;
  }): Promise<RepairOrderStatus | null> {
    // Never invent RO status
    return null;
  }

  async requestServiceAppointment(
    params: ServiceAppointmentRequest,
  ): Promise<ServiceAppointmentResult> {
    // Without live Tekion confirmation, remain REQUESTED only
    return {
      externalId: null,
      status: 'REQUESTED',
      confirmed: false,
      message:
        'Service appointment preference recorded. Confirmation requires live Tekion scheduling — not yet configured.',
      provider: this.providerId,
    };
  }
}
