import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryIngestionService } from '../integrations/vauto/inventory-ingestion.service';
import { VAutoSftpIngestionService } from '../integrations/vauto/vauto-sftp-ingestion.service';
import { tryAcquireSftpIngestLock } from './sftp-ingest-lock';

@Injectable()
export class InventorySyncService {
  private readonly logger = new Logger(InventorySyncService.name);
  private sftpRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ingestion: InventoryIngestionService,
    private readonly sftpIngestion: VAutoSftpIngestionService,
  ) {}

  @Cron('*/30 * * * *')
  async sync() {
    if (process.env.INVENTORY_SYNC_ENABLED !== 'true') {
      this.logger.debug(
        'Inventory sync disabled (INVENTORY_SYNC_ENABLED!=true)',
      );
      return;
    }

    this.logger.log(
      'Inventory auto-sync started (validated two-phase ingestion)',
    );

    const locations = await this.prisma.location.findMany({
      where: {
        inventoryFeedUrl: { not: null },
        inventoryFeedType: { not: null },
      },
    });

    const locationsWithFeeds = locations.filter(
      (l) =>
        typeof l.inventoryFeedUrl === 'string' &&
        l.inventoryFeedUrl.trim().length > 0 &&
        l.inventoryFeedType != null,
    );

    if (!locationsWithFeeds.length) {
      this.logger.log('No HTTPS inventory feeds configured');
    }

    for (const location of locationsWithFeeds) {
      try {
        const result = await this.ingestion.runForLocation(location.id);
        this.logger.log(
          `Inventory sync ${result.status} for ${location.name} run=${result.runId}`,
        );
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(`Inventory sync failed for ${location.name}: ${msg}`);
      }
    }

    await this.syncDialDifferenceSftp();

    this.logger.log('Inventory auto-sync finished');
  }

  /** Independent of HTTPS feeds; gated by AMQUR_VAUTO_SFTP_ENABLED. */
  private async syncDialDifferenceSftp() {
    if (!this.sftpIngestion.isEnabled()) {
      this.logger.debug('Dial Difference SFTP sync disabled');
      return;
    }
    if (this.sftpRunning) {
      this.logger.warn('Dial Difference SFTP sync already in progress — skip');
      return;
    }
    const release = await tryAcquireSftpIngestLock();
    if (!release) {
      this.logger.warn(
        'Dial Difference SFTP sync skipped — another worker holds the Redis lock',
      );
      return;
    }
    this.sftpRunning = true;
    try {
      const results = await this.sftpIngestion.runAllSources();
      for (const r of results) {
        this.logger.log(
          `SFTP source=${r.feedSourceKey} status=${r.status} run=${r.runId ?? '-'}`,
        );
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Dial Difference SFTP sync failed: ${msg}`);
    } finally {
      this.sftpRunning = false;
      await release();
    }
  }
}
