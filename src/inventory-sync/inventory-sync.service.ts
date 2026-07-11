import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryFeedService } from '../inventory-feed/inventory-feed.service';
import { InventoryService } from '../inventory/inventory.service';
import { VehicleNormalizer } from '../inventory-feed/normalizer/vehicle.normalizer';
import { assertFeedUrlAllowed } from '../common/security/feed-url.guard';

@Injectable()
export class InventorySyncService {
  private readonly logger = new Logger(InventorySyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly feed: InventoryFeedService,
    private readonly inventory: InventoryService,
  ) {}

  @Cron('*/30 * * * *')
  async sync() {
    if (process.env.INVENTORY_SYNC_ENABLED !== 'true') {
      this.logger.debug('Inventory sync disabled (INVENTORY_SYNC_ENABLED!=true)');
      return;
    }

    this.logger.log('Inventory auto-sync started');

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
        this.logger.log(`Inventory sync starting for ${location.name}`);

        assertFeedUrlAllowed(location.inventoryFeedUrl!);

        const rawFeed = await this.feed.fetchFeed(location.inventoryFeedUrl!);
        const records = this.feed.parseFeed(
          location.inventoryFeedType as 'XML' | 'JSON' | 'CSV',
          rawFeed,
        );

        const vehicles = records
          .map((r) => VehicleNormalizer.normalize(r))
          .filter((v): v is NonNullable<typeof v> => v !== null);

        this.logger.log(
          `Parsed ${records.length} records, normalized ${vehicles.length} for ${location.name}`,
        );

        await this.inventory.upsertVehicles(
          location.tenantId,
          location.id,
          vehicles,
        );
        await this.inventory.updateVehicleLifecycle(location.id);

        this.logger.log(
          `${vehicles.length} vehicles synced for ${location.name}`,
        );
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(`Inventory sync failed for ${location.name}: ${msg}`);
      }
    }

    this.logger.log('Inventory auto-sync finished');
  }
}
