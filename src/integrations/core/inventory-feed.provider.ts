import type { InventoryVehicle } from '../../chat/types/vehicle.types';

/** Authorized inventory feed transports — no invented vendor REST. */
export type InventoryFeedTransport =
  | 'HTTPS'
  | 'SFTP'
  | 'FTP'
  | 'SIGNED_URL'
  | 'FILE';

export type InventoryFeedFormat = 'XML' | 'JSON' | 'CSV';

export type InventoryFeedSnapshot = {
  provider: string;
  transport: InventoryFeedTransport;
  format: InventoryFeedFormat;
  sourceIdentifier: string;
  checksum?: string | null;
  fetchedAt: string;
  raw: string | Buffer;
};

export type InventoryFeedValidationResult = {
  ok: boolean;
  recordCount: number;
  validCount: number;
  rejectedCount: number;
  anomalies: string[];
  vehicles: InventoryVehicle[];
};

export interface InventoryFeedProvider {
  readonly providerId: string;
  isLiveConfigured(): boolean;
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
  fetchSnapshot(params: {
    tenantId: string;
    locationId: string;
    url?: string | null;
    format?: InventoryFeedFormat | null;
  }): Promise<InventoryFeedSnapshot>;
  validateAndNormalize(
    snapshot: InventoryFeedSnapshot,
    opts: { minRecords: number; previousCount?: number | null },
  ): Promise<InventoryFeedValidationResult>;
}
