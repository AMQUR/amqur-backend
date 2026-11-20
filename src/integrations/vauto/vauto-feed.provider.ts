import { createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InventoryFeedService } from '../../inventory-feed/inventory-feed.service';
import { VehicleNormalizer } from '../../inventory-feed/normalizer/vehicle.normalizer';
import { assertFeedUrlAllowed } from '../../common/security/feed-url.guard';
import type {
  InventoryFeedFormat,
  InventoryFeedProvider,
  InventoryFeedSnapshot,
  InventoryFeedValidationResult,
} from '../core/inventory-feed.provider';

/**
 * vAuto-oriented inventory feed provider.
 * Uses authorized HTTPS (or other configured) feed download — not invented REST APIs.
 * Treats empty/anomalous snapshots as unsafe for destructive reconciliation.
 */
@Injectable()
export class VAutoFeedProvider implements InventoryFeedProvider {
  readonly providerId = 'vauto';
  private readonly logger = new Logger(VAutoFeedProvider.name);

  constructor(
    private readonly feed: InventoryFeedService,
    private readonly config: ConfigService,
  ) {}

  isLiveConfigured(): boolean {
    // HTTPS feed URLs are per-location; SFTP path is separately gated.
    return true;
  }

  /**
   * Honest health: transport library ready; SFTP ingest remains off unless flagged.
   * Does not open a network connection or report false LIVE readiness.
   */
  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    const sftpEnabled =
      this.config.get<string>('AMQUR_VAUTO_SFTP_ENABLED') === 'true';
    const syncEnabled =
      this.config.get<string>('INVENTORY_SYNC_ENABLED') === 'true';
    const passwordSet = Boolean(
      (this.config.get<string>('AMQUR_VAUTO_SFTP_PASSWORD') ?? '').trim(),
    );
    const fpSet = Boolean(
      (
        this.config.get<string>('AMQUR_VAUTO_SFTP_HOST_FINGERPRINT') ?? ''
      ).trim(),
    );
    return {
      ok: true,
      detail: [
        'https_feed_transport_ready',
        `sftp_ingest=${sftpEnabled ? 'enabled' : 'disabled'}`,
        `inventory_sync=${syncEnabled ? 'enabled' : 'disabled'}`,
        `sftp_password=${passwordSet ? 'set' : 'missing'}`,
        `sftp_host_fingerprint=${fpSet ? 'set' : 'missing'}`,
      ].join(';'),
    };
  }

  async fetchSnapshot(params: {
    tenantId: string;
    locationId: string;
    url?: string | null;
    format?: InventoryFeedFormat | null;
  }): Promise<InventoryFeedSnapshot> {
    if (!params.url) {
      throw new Error('vAuto feed URL not configured for location');
    }
    assertFeedUrlAllowed(params.url);
    const raw = await this.feed.fetchFeed(params.url);
    const checksum = createHash('sha256').update(raw).digest('hex');
    return {
      provider: this.providerId,
      transport: 'HTTPS',
      format: (params.format ?? 'XML') as InventoryFeedFormat,
      sourceIdentifier: params.url,
      checksum,
      fetchedAt: new Date().toISOString(),
      raw,
    };
  }

  async validateAndNormalize(
    snapshot: InventoryFeedSnapshot,
    opts: { minRecords: number; previousCount?: number | null },
  ): Promise<InventoryFeedValidationResult> {
    const anomalies: string[] = [];
    const records = this.feed.parseFeed(
      snapshot.format,
      snapshot.raw.toString(),
    );
    const vehicles = records
      .map((r) => VehicleNormalizer.normalize(r))
      .filter((v): v is NonNullable<typeof v> => v !== null)
      .map((v) => ({ ...v, source: 'vauto_feed' }));

    const recordCount = records.length;
    const validCount = vehicles.length;
    const rejectedCount = recordCount - validCount;

    if (validCount < opts.minRecords) {
      anomalies.push(`below_min_records:${validCount}<${opts.minRecords}`);
    }
    if (validCount === 0) {
      anomalies.push('empty_normalized_inventory');
    }
    if (
      opts.previousCount != null &&
      opts.previousCount > 20 &&
      validCount < Math.floor(opts.previousCount * 0.2)
    ) {
      anomalies.push(
        `size_drop_anomaly:prev=${opts.previousCount},now=${validCount}`,
      );
    }

    // Price anomaly: negative or absurdly high
    const badPrices = vehicles.filter(
      (v) => v.price != null && (v.price < 0 || v.price > 2_000_000),
    );
    if (badPrices.length > 0) {
      anomalies.push(`price_anomaly_count:${badPrices.length}`);
    }

    const ok = anomalies.length === 0;
    if (!ok) {
      this.logger.warn(
        `vAuto snapshot rejected anomalies=${anomalies.join(',')}`,
      );
    }

    return {
      ok,
      recordCount,
      validCount,
      rejectedCount,
      anomalies,
      vehicles: ok ? vehicles : [],
    };
  }
}
