import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  InventoryFreshnessState,
  InventoryImportStatus,
  IntegrationProvider,
  Prisma,
} from '@prisma/client';
import { VAutoFeedProvider } from './vauto-feed.provider';
import { InventoryService } from '../../inventory/inventory.service';
import { MetricsService } from '../../observability/metrics.service';

/**
 * Two-phase inventory import: validate → reconcile.
 * Rejects anomalous empty snapshots so last-known-good inventory is preserved.
 */
@Injectable()
export class InventoryIngestionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vauto: VAutoFeedProvider,
    private readonly inventory: InventoryService,
    private readonly metrics: MetricsService,
  ) {}

  async runForLocation(locationId: string) {
    const location = await this.prisma.location.findUnique({
      where: { id: locationId },
    });
    if (!location?.inventoryFeedUrl || !location.inventoryFeedType) {
      throw new Error('Location feed not configured');
    }

    const run = await this.prisma.inventoryImportRun.create({
      data: {
        tenantId: location.tenantId,
        locationId: location.id,
        provider: IntegrationProvider.VAUTO,
        transport: 'HTTPS',
        format: location.inventoryFeedType,
        status: InventoryImportStatus.PENDING,
      },
    });

    try {
      const snapshot = await this.vauto.fetchSnapshot({
        tenantId: location.tenantId,
        locationId: location.id,
        url: location.inventoryFeedUrl,
        format: location.inventoryFeedType,
      });

      await this.prisma.inventoryImportRun.update({
        where: { id: run.id },
        data: {
          status: InventoryImportStatus.DOWNLOADED,
          sourceIdentifier: snapshot.sourceIdentifier,
          checksum: snapshot.checksum,
        },
      });

      const previousCount = await this.prisma.vehicle.count({
        where: {
          tenantId: location.tenantId,
          locationId: location.id,
          status: { in: ['AVAILABLE', 'IN_TRANSIT', 'HOLD'] },
        },
      });

      await this.prisma.inventoryImportRun.update({
        where: { id: run.id },
        data: { status: InventoryImportStatus.VALIDATING },
      });

      const validated = await this.vauto.validateAndNormalize(snapshot, {
        minRecords: location.inventoryMinRecords ?? 1,
        previousCount,
      });

      if (!validated.ok) {
        this.metrics.increment('inventory.import.rejected');
        await this.prisma.inventoryImportRun.update({
          where: { id: run.id },
          data: {
            status: InventoryImportStatus.REJECTED_ANOMALY,
            recordCount: validated.recordCount,
            validCount: validated.validCount,
            rejectedCount: validated.rejectedCount,
            anomalyFlags: validated.anomalies as Prisma.InputJsonValue,
            errorMessage: validated.anomalies.join('; ').slice(0, 500),
            completedAt: new Date(),
          },
        });
        return {
          runId: run.id,
          status: 'REJECTED_ANOMALY' as const,
          anomalies: validated.anomalies,
          preservedInventory: true,
        };
      }

      await this.prisma.inventoryImportRun.update({
        where: { id: run.id },
        data: {
          status: InventoryImportStatus.RECONCILING,
          recordCount: validated.recordCount,
          validCount: validated.validCount,
          rejectedCount: validated.rejectedCount,
        },
      });

      await this.inventory.upsertVehicles(
        location.tenantId,
        location.id,
        validated.vehicles,
        {
          source: 'vauto_feed',
          importRunId: run.id,
          freshnessState: InventoryFreshnessState.FRESH,
        },
      );
      await this.inventory.updateVehicleLifecycle(location.id);

      await this.prisma.inventoryImportRun.update({
        where: { id: run.id },
        data: {
          status: InventoryImportStatus.SUCCEEDED,
          completedAt: new Date(),
        },
      });
      this.metrics.increment('inventory.import.succeeded');

      return {
        runId: run.id,
        status: 'SUCCEEDED' as const,
        validCount: validated.validCount,
        preservedInventory: false,
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.metrics.increment('inventory.import.failed');
      await this.prisma.inventoryImportRun.update({
        where: { id: run.id },
        data: {
          status: InventoryImportStatus.FAILED,
          errorMessage: msg.slice(0, 500),
          completedAt: new Date(),
        },
      });
      throw e;
    }
  }
}
