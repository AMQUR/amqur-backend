import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryIngestionService } from '../integrations/vauto/inventory-ingestion.service';

@Injectable()
export class InventorySyncService {
  private readonly logger = new Logger(InventorySyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ingestion: InventoryIngestionService,
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
      this.logger.log('No inventory feeds configured');
      return;
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

    this.logger.log('Inventory auto-sync finished');
  }
}
