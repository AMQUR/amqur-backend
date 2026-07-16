/**
 * Integration provider contracts.
 * Live adapters must honor tenant credentials, sandbox/prod mode, enabled/liveReady,
 * timeouts, retries, circuit breakers, rate limits, idempotency, source timestamps,
 * audit logging, health probes, and encrypted credentials.
 *
 * Do not invent vendor endpoints — implement only against authorized docs.
 */

export type ProviderMode = 'sandbox' | 'production';

export type ProviderContext = {
  tenantId: string;
  locationId?: string | null;
  mode: ProviderMode;
  timeoutMs: number;
  idempotencyKey?: string;
};

export interface InventoryProvider {
  readonly name: string;
  isLiveReady(ctx: ProviderContext): Promise<boolean>;
  health(ctx: ProviderContext): Promise<{ ok: boolean; detail?: string }>;
  /** Pull or acknowledge a feed snapshot; never fabricate vehicles. */
  syncInventory?(ctx: ProviderContext): Promise<{
    importRunId: string;
    recordCount: number;
    sourceTimestamp?: string;
  }>;
}

export interface CrmProvider {
  readonly name: string;
  isLiveReady(ctx: ProviderContext): Promise<boolean>;
  health(ctx: ProviderContext): Promise<{ ok: boolean; detail?: string }>;
  upsertLead?(
    ctx: ProviderContext,
    payload: Record<string, unknown>,
  ): Promise<{ externalLeadId?: string; accepted: boolean }>;
}

export interface DmsProvider {
  readonly name: string;
  isLiveReady(ctx: ProviderContext): Promise<boolean>;
  health(ctx: ProviderContext): Promise<{ ok: boolean; detail?: string }>;
}

export interface ServiceSchedulingProvider {
  readonly name: string;
  isLiveReady(ctx: ProviderContext): Promise<boolean>;
  /** Must not claim confirmed slots without verified calendar/DMS response. */
  requestAppointment?(
    ctx: ProviderContext,
    payload: Record<string, unknown>,
  ): Promise<{ confirmed: boolean; status: string }>;
}

export interface PartsProvider {
  readonly name: string;
  isLiveReady(ctx: ProviderContext): Promise<boolean>;
  /** Never invent fitment/price/availability. */
  inquire?(
    ctx: ProviderContext,
    payload: Record<string, unknown>,
  ): Promise<{ verified: boolean; notes?: string }>;
}

export interface MessagingProvider {
  readonly name: string;
  isLiveReady(ctx: ProviderContext): Promise<boolean>;
  send?(
    ctx: ProviderContext,
    payload: { to: string; body: string; channel: string },
  ): Promise<{ accepted: boolean; providerMessageId?: string }>;
}

export interface WebsiteContentProvider {
  readonly name: string;
  isLiveReady(ctx: ProviderContext): Promise<boolean>;
  /** Verified website content only — not general AI inference. */
  fetchApprovedContent?(
    ctx: ProviderContext,
    key: string,
  ): Promise<{ content: string; sourceTimestamp?: string } | null>;
}
