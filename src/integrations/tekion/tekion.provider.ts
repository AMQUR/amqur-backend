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
import {
  NO_TEKION_CAPABILITIES,
  TekionCapabilities,
} from './tekion.capabilities';

export class TekionNotAuthorizedError extends Error {
  constructor(operation: string) {
    super(`tekion_not_authorized:${operation}`);
  }
}

/**
 * Tekion adapter boundary.
 *
 * The HTTP client is intentionally NOT implemented: AMQUR has no official Tekion partner API
 * specification or credentials in this repository, and endpoints must never be guessed or
 * reverse-engineered. Every write/read therefore fails closed with TekionNotAuthorizedError,
 * health reports `awaiting_vendor_credentials`, and no caller can mistake this for success.
 *
 * Activation path (docs/TEKION_INTEGRATION.md): implement `TekionHttpClient` strictly from the
 * official spec, store credentials via SecretVault, set IntegrationConnection.config
 * {apiBaseUrl, environment, dealerId, storeId, contractVerifiedAt, capabilities}, run the
 * contract suite against the Tekion sandbox, then enable per capability.
 */
@Injectable()
export class TekionProvider implements CrmProvider, DmsProvider {
  readonly providerId = 'tekion';
  private readonly logger = new Logger(TekionProvider.name);

  /** True only when an official HTTP client exists AND is configured. Never true today. */
  isLiveConfigured(): boolean {
    return false;
  }

  capabilities(): TekionCapabilities {
    return { ...NO_TEKION_CAPABILITIES };
  }

  async healthCheck(): Promise<{
    ok: boolean;
    detail?: string;
    status: 'awaiting_vendor_credentials' | 'healthy' | 'degraded' | 'down';
  }> {
    return {
      ok: false,
      status: 'awaiting_vendor_credentials',
      detail:
        'Tekion partner credentials and official API contract not provided — integration disabled.',
    };
  }

  async findCustomer(_p: {
    tenantId: string;
    email?: string | null;
    phone?: string | null;
  }): Promise<CrmCustomer | null> {
    throw new TekionNotAuthorizedError('crmCustomerRead');
  }

  async upsertCustomer(_p: CrmLeadInput): Promise<CrmCustomer> {
    throw new TekionNotAuthorizedError('crmCustomerUpsert');
  }

  async createOrUpdateLead(_p: CrmLeadInput): Promise<CrmLeadResult> {
    throw new TekionNotAuthorizedError('crmLeadCreateOrUpdate');
  }

  async appendActivity(_p: CrmActivityInput): Promise<{ ok: boolean }> {
    throw new TekionNotAuthorizedError('crmActivityAppend');
  }

  async getRepairOrderStatus(_p: {
    tenantId: string;
    externalId?: string;
    vin?: string;
  }): Promise<RepairOrderStatus | null> {
    // Never invent RO status.
    return null;
  }

  async requestServiceAppointment(
    _p: ServiceAppointmentRequest,
  ): Promise<ServiceAppointmentResult> {
    return {
      externalId: null,
      status: 'REQUESTED',
      confirmed: false,
      message:
        'Tekion scheduling not authorized — AMQUR keeps this as a request only.',
      provider: this.providerId,
    };
  }
}
