/** Provider-neutral CRM capabilities. Live Tekion wiring requires partner credentials. */
export type CrmCustomer = {
  externalId: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  source: string;
};

export type CrmLeadInput = {
  tenantId: string;
  locationId?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  interestedVin?: string | null;
  source?: string | null;
  notes?: string | null;
  idempotencyKey: string;
  conversationId?: string | null;
  utm?: { source?: string; medium?: string; campaign?: string };
};

export type CrmLeadResult = {
  externalLeadId: string;
  externalCustomerId?: string | null;
  duplicated: boolean;
  provider: string;
};

export type CrmActivityInput = {
  tenantId: string;
  externalLeadId?: string | null;
  externalCustomerId?: string | null;
  summary: string;
  channel: string;
  idempotencyKey: string;
};

export interface CrmProvider {
  readonly providerId: string;
  isLiveConfigured(): boolean;
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
  findCustomer(params: {
    tenantId: string;
    email?: string | null;
    phone?: string | null;
  }): Promise<CrmCustomer | null>;
  upsertCustomer(params: CrmLeadInput): Promise<CrmCustomer>;
  createOrUpdateLead(params: CrmLeadInput): Promise<CrmLeadResult>;
  appendActivity(params: CrmActivityInput): Promise<{ ok: boolean }>;
}
