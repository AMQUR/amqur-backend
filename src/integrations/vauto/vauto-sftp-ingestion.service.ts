import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  InventoryFreshnessState,
  InventoryImportStatus,
  IntegrationProvider,
  Prisma,
} from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryFeedService } from '../../inventory-feed/inventory-feed.service';
import { VehicleNormalizer } from '../../inventory-feed/normalizer/vehicle.normalizer';
import { InventoryService } from '../../inventory/inventory.service';
import { MetricsService } from '../../observability/metrics.service';
import {
  DIAL_DIFFERENCE_FEED_SOURCES,
  type DialDifferenceFeedSource,
  feedSourceByKey,
} from './dial-difference-feed-map';
import { FixtureSftpTransport } from './sftp/fixture-sftp-transport';
import { SftpGoClient } from './sftp/sftpgo-client';
import type { InventorySftpTransport } from './sftp/sftp-transport';
import type { InventoryFeedFormat } from '../core/inventory-feed.provider';

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

export type SftpIngestResult = {
  feedSourceKey: string;
  status:
    | 'SUCCEEDED'
    | 'REJECTED_ANOMALY'
    | 'FAILED'
    | 'SKIPPED_DISABLED'
    | 'SKIPPED_NO_FILE'
    | 'SKIPPED_UNMAPPED_TENANT';
  runId?: string;
  validCount?: number;
  anomalies?: string[];
  preservedInventory?: boolean;
  detail?: string;
};

/**
 * Dial Difference SFTPGo → AMQUR inventory for all ten New/Used sources.
 * Default-off. Customer-facing prices/photos stay suppressed until explicitly enabled.
 */
@Injectable()
export class VAutoSftpIngestionService {
  private readonly logger = new Logger(VAutoSftpIngestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly feed: InventoryFeedService,
    private readonly inventory: InventoryService,
    private readonly metrics: MetricsService,
  ) {}

  isEnabled(): boolean {
    return this.config.get<string>('AMQUR_VAUTO_SFTP_ENABLED') === 'true';
  }

  /** Live SFTP credentials present (password never returned). */
  credentialsConfigured(): boolean {
    const host = this.config.get<string>('AMQUR_VAUTO_SFTP_HOST') ?? '';
    const user = this.config.get<string>('AMQUR_VAUTO_SFTP_USER') ?? '';
    const pass = this.config.get<string>('AMQUR_VAUTO_SFTP_PASSWORD') ?? '';
    const fp =
      this.config.get<string>('AMQUR_VAUTO_SFTP_HOST_FINGERPRINT') ?? '';
    return Boolean(host && user && pass && fp);
  }

  /**
   * Operator-safe Dial Difference SFTP status (no secrets).
   * Does not open a network connection — configuration and flag presence only.
   */
  operatorStatus(): {
    ingestEnabled: boolean;
    inventorySyncEnabled: boolean;
    credentialsConfigured: boolean;
    publishPrices: boolean;
    publishPhotos: boolean;
    hostConfigured: boolean;
    feedSourceCount: number;
  } {
    return {
      ingestEnabled: this.isEnabled(),
      inventorySyncEnabled:
        this.config.get<string>('INVENTORY_SYNC_ENABLED') === 'true',
      credentialsConfigured: this.credentialsConfigured(),
      publishPrices: this.publishPrices(),
      publishPhotos: this.publishPhotos(),
      hostConfigured: Boolean(
        (this.config.get<string>('AMQUR_VAUTO_SFTP_HOST') ?? '').trim(),
      ),
      feedSourceCount: DIAL_DIFFERENCE_FEED_SOURCES.length,
    };
  }

  private publishPrices(): boolean {
    return this.config.get<string>('AMQUR_VAUTO_PUBLISH_PRICES') === 'true';
  }

  private publishPhotos(): boolean {
    return this.config.get<string>('AMQUR_VAUTO_PUBLISH_PHOTOS') === 'true';
  }

  private maxBytes(): number {
    const n = Number(this.config.get<string>('AMQUR_VAUTO_SFTP_MAX_BYTES'));
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
  }

  /**
   * Build a transport. Prefers fixture root for tests; otherwise live SFTP when enabled+configured.
   */
  createTransport(fixtureRoot?: string): InventorySftpTransport {
    if (fixtureRoot) return new FixtureSftpTransport(fixtureRoot);
    if (!this.credentialsConfigured()) {
      throw new Error('sftp_credentials_not_configured');
    }
    return new SftpGoClient({
      host: this.config.get<string>('AMQUR_VAUTO_SFTP_HOST')!,
      port: Number(this.config.get<string>('AMQUR_VAUTO_SFTP_PORT') ?? 2022),
      username: this.config.get<string>('AMQUR_VAUTO_SFTP_USER')!,
      password: this.config.get<string>('AMQUR_VAUTO_SFTP_PASSWORD')!,
      hostFingerprintSha256: this.config.get<string>(
        'AMQUR_VAUTO_SFTP_HOST_FINGERPRINT',
      )!,
    });
  }

  detectFormat(filename: string, body: Buffer): InventoryFeedFormat | null {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.xml')) return 'XML';
    if (lower.endsWith('.json')) return 'JSON';
    if (lower.endsWith('.csv') || lower.endsWith('.txt')) return 'CSV';
    const head = body.subarray(0, 256).toString('utf8').trimStart();
    if (head.startsWith('<')) return 'XML';
    if (head.startsWith('{') || head.startsWith('[')) return 'JSON';
    if (head.includes(',') && /vin/i.test(head.slice(0, 200))) return 'CSV';
    return null;
  }

  async runAllSources(opts?: {
    fixtureRoot?: string;
    onlyKeys?: string[];
  }): Promise<SftpIngestResult[]> {
    if (!this.isEnabled() && !opts?.fixtureRoot) {
      return DIAL_DIFFERENCE_FEED_SOURCES.map((s) => ({
        feedSourceKey: s.feedSourceKey,
        status: 'SKIPPED_DISABLED' as const,
      }));
    }
    const transport = this.createTransport(opts?.fixtureRoot);
    const results: SftpIngestResult[] = [];
    try {
      for (const source of DIAL_DIFFERENCE_FEED_SOURCES) {
        if (
          opts?.onlyKeys?.length &&
          !opts.onlyKeys.includes(source.feedSourceKey)
        ) {
          continue;
        }
        try {
          results.push(await this.runOneSource(source, transport));
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          this.logger.error(
            `SFTP ingest failed source=${source.feedSourceKey} err=${msg}`,
          );
          results.push({
            feedSourceKey: source.feedSourceKey,
            status: 'FAILED',
            detail: msg.slice(0, 200),
          });
        }
      }
    } finally {
      await transport.dispose();
    }
    return results;
  }

  async runOneSource(
    source: DialDifferenceFeedSource,
    transport: InventorySftpTransport,
  ): Promise<SftpIngestResult> {
    const tenant = await this.prisma.tenant.findFirst({
      where: { slug: source.tenantSlug },
      select: { id: true, slug: true },
    });
    if (!tenant) {
      return {
        feedSourceKey: source.feedSourceKey,
        status: 'SKIPPED_UNMAPPED_TENANT',
        detail: `tenant slug ${source.tenantSlug} not found`,
      };
    }
    const location = await this.prisma.location.findFirst({
      where: { tenantId: tenant.id, slug: source.locationSlug },
    });
    if (!location) {
      return {
        feedSourceKey: source.feedSourceKey,
        status: 'SKIPPED_UNMAPPED_TENANT',
        detail: `location ${source.locationSlug} missing for ${source.tenantSlug}`,
      };
    }

    const listed = await transport.list(source.remoteDir);
    if (!listed.length) {
      return {
        feedSourceKey: source.feedSourceKey,
        status: 'SKIPPED_NO_FILE',
        detail: 'directory empty or unavailable',
      };
    }
    // Prefer the newest eligible file.
    listed.sort((a, b) => b.modifyTimeMs - a.modifyTimeMs);
    const chosen = listed[0];

    const run = await this.prisma.inventoryImportRun.create({
      data: {
        tenantId: tenant.id,
        locationId: location.id,
        provider: IntegrationProvider.VAUTO,
        transport: 'SFTP',
        feedSourceKey: source.feedSourceKey,
        sourceCondition: source.condition,
        status: InventoryImportStatus.PENDING,
        sourceIdentifier: chosen.remotePath,
      },
    });

    try {
      const file = await transport.download(chosen.remotePath, this.maxBytes());
      const format = this.detectFormat(file.name, file.body);
      if (!format) {
        await this.prisma.inventoryImportRun.update({
          where: { id: run.id },
          data: {
            status: InventoryImportStatus.FAILED,
            errorMessage: 'unsupported_or_unknown_format',
            checksum: file.checksumSha256,
            completedAt: new Date(),
          },
        });
        return {
          feedSourceKey: source.feedSourceKey,
          status: 'FAILED',
          runId: run.id,
          detail: 'unsupported_or_unknown_format',
        };
      }

      await this.prisma.inventoryImportRun.update({
        where: { id: run.id },
        data: {
          status: InventoryImportStatus.DOWNLOADED,
          format,
          checksum: file.checksumSha256,
        },
      });

      // Idempotent skip: same checksum already succeeded for this source.
      const prior = await this.prisma.inventoryImportRun.findFirst({
        where: {
          feedSourceKey: source.feedSourceKey,
          checksum: file.checksumSha256,
          status: InventoryImportStatus.SUCCEEDED,
          id: { not: run.id },
        },
        orderBy: { completedAt: 'desc' },
      });
      if (prior) {
        await this.prisma.inventoryImportRun.update({
          where: { id: run.id },
          data: {
            status: InventoryImportStatus.SUCCEEDED,
            errorMessage: 'duplicate_checksum_skipped',
            completedAt: new Date(),
            recordCount: prior.recordCount,
            validCount: prior.validCount,
          },
        });
        return {
          feedSourceKey: source.feedSourceKey,
          status: 'SUCCEEDED',
          runId: run.id,
          validCount: prior.validCount ?? 0,
          detail: 'duplicate_checksum_skipped',
          preservedInventory: true,
        };
      }

      const previousCount = await this.prisma.vehicle.count({
        where: {
          tenantId: tenant.id,
          locationId: location.id,
          feedSourceKey: source.feedSourceKey,
          status: {
            in: ['AVAILABLE', 'IN_TRANSIT', 'HOLD', 'MISSING'],
          },
        },
      });

      await this.prisma.inventoryImportRun.update({
        where: { id: run.id },
        data: { status: InventoryImportStatus.VALIDATING },
      });

      const records = this.feed.parseFeed(format, file.body.toString('utf8'));
      const vehicles = records
        .map((r) => VehicleNormalizer.normalize(r))
        .filter((v): v is NonNullable<typeof v> => v !== null)
        .map((v) => ({
          ...v,
          condition: source.condition,
          source: `vauto_sftp:${source.feedSourceKey}`,
        }));

      const anomalies: string[] = [];
      const minRecords = location.inventoryMinRecords ?? 1;
      if (vehicles.length < minRecords) {
        anomalies.push(`below_min_records:${vehicles.length}<${minRecords}`);
      }
      if (vehicles.length === 0) anomalies.push('empty_normalized_inventory');
      if (
        previousCount > 20 &&
        vehicles.length < Math.floor(previousCount * 0.2)
      ) {
        anomalies.push(
          `size_drop_anomaly:prev=${previousCount},now=${vehicles.length}`,
        );
      }

      if (anomalies.length) {
        this.metrics.increment('inventory.sftp.import.rejected');
        await this.prisma.inventoryImportRun.update({
          where: { id: run.id },
          data: {
            status: InventoryImportStatus.REJECTED_ANOMALY,
            recordCount: records.length,
            validCount: vehicles.length,
            rejectedCount: records.length - vehicles.length,
            anomalyFlags: anomalies as unknown as Prisma.InputJsonValue,
            errorMessage: anomalies.join('; ').slice(0, 500),
            completedAt: new Date(),
          },
        });
        return {
          feedSourceKey: source.feedSourceKey,
          status: 'REJECTED_ANOMALY',
          runId: run.id,
          anomalies,
          preservedInventory: true,
        };
      }

      await this.prisma.inventoryImportRun.update({
        where: { id: run.id },
        data: {
          status: InventoryImportStatus.RECONCILING,
          recordCount: records.length,
          validCount: vehicles.length,
          rejectedCount: records.length - vehicles.length,
        },
      });

      await this.inventory.upsertVehicles(tenant.id, location.id, vehicles, {
        source: `vauto_sftp:${source.feedSourceKey}`,
        importRunId: run.id,
        freshnessState: InventoryFreshnessState.FRESH,
        feedSourceKey: source.feedSourceKey,
        publishPrices: this.publishPrices(),
        publishPhotos: this.publishPhotos(),
      });

      await this.inventory.updateVehicleLifecycle(location.id, {
        feedSourceKey: source.feedSourceKey,
        snapshotStartedAt: run.startedAt,
      });

      await this.prisma.inventoryImportRun.update({
        where: { id: run.id },
        data: {
          status: InventoryImportStatus.SUCCEEDED,
          completedAt: new Date(),
        },
      });
      this.metrics.increment('inventory.sftp.import.succeeded');

      return {
        feedSourceKey: source.feedSourceKey,
        status: 'SUCCEEDED',
        runId: run.id,
        validCount: vehicles.length,
        preservedInventory: false,
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.metrics.increment('inventory.sftp.import.failed');
      await this.prisma.inventoryImportRun.update({
        where: { id: run.id },
        data: {
          status: InventoryImportStatus.FAILED,
          errorMessage: msg.slice(0, 500),
          completedAt: new Date(),
        },
      });
      return {
        feedSourceKey: source.feedSourceKey,
        status: 'FAILED',
        runId: run.id,
        detail: msg.slice(0, 200),
        preservedInventory: true,
      };
    }
  }

  /** Resolve a source by key for ops/tests. */
  source(key: string): DialDifferenceFeedSource | undefined {
    return feedSourceByKey(key);
  }

  /** Fingerprint helper for ops docs (no network). */
  static checksum(buf: Buffer): string {
    return createHash('sha256').update(buf).digest('hex');
  }
}
