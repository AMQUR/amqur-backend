/**
 * Tekion capabilities are DECLARED by an operator only after the official partner contract
 * for that operation has been verified for the dealership (IntegrationConnection.config
 * `capabilities` + `contractVerifiedAt`). Nothing is inferred from code presence.
 */
export type TekionCapabilities = {
  crmCustomerRead: boolean;
  crmCustomerUpsert: boolean;
  crmLeadCreateOrUpdate: boolean;
  crmActivityAppend: boolean;
  appointmentAvailabilityRead: boolean;
  appointmentCreate: boolean;
  appointmentUpdate: boolean;
  appointmentCancel: boolean;
  serviceCustomerVehicleRead: boolean;
  repairOrderRead: boolean;
  partsCatalogRead: boolean;
  partsInventoryRead: boolean;
  partsOrderCreate: boolean;
  webhookEvents: boolean;
};

export const NO_TEKION_CAPABILITIES: TekionCapabilities = {
  crmCustomerRead: false,
  crmCustomerUpsert: false,
  crmLeadCreateOrUpdate: false,
  crmActivityAppend: false,
  appointmentAvailabilityRead: false,
  appointmentCreate: false,
  appointmentUpdate: false,
  appointmentCancel: false,
  serviceCustomerVehicleRead: false,
  repairOrderRead: false,
  partsCatalogRead: false,
  partsInventoryRead: false,
  partsOrderCreate: false,
  webhookEvents: false,
};

export type TekionConnectionConfig = {
  environment?: 'sandbox' | 'production';
  /** Official base URL from Tekion partner onboarding — never guessed. */
  apiBaseUrl?: string;
  dealerId?: string;
  storeId?: string;
  contractVerifiedAt?: string;
  contractVersion?: string;
  capabilities?: Partial<TekionCapabilities>;
};

export function resolveTekionCapabilities(
  cfg: TekionConnectionConfig | null | undefined,
): TekionCapabilities {
  if (
    !cfg?.contractVerifiedAt ||
    !cfg.apiBaseUrl ||
    !/^https:\/\//.test(cfg.apiBaseUrl)
  ) {
    return { ...NO_TEKION_CAPABILITIES };
  }
  const out = { ...NO_TEKION_CAPABILITIES };
  for (const k of Object.keys(out) as Array<keyof TekionCapabilities>) {
    out[k] = cfg.capabilities?.[k] === true;
  }
  return out;
}
