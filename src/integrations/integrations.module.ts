import { Module } from '@nestjs/common';
import { SecretVaultService } from './core/secret-vault.service';
import { CircuitBreakerService } from './core/circuit-breaker.service';
import { OutboxService } from './core/outbox.service';
import { TekionProvider } from './tekion/tekion.provider';
import { VAutoFeedProvider } from './vauto/vauto-feed.provider';
import { InventoryIngestionService } from './vauto/inventory-ingestion.service';
import { TekionCrmWritebackService } from './tekion/tekion-crm-writeback.service';
import { IntegrationsHealthController } from './integrations-health.controller';
import { WebhookInboxService } from './core/webhook-inbox.service';
import { InventoryFeedModule } from '../inventory-feed/inventory-feed.module';
import { InventoryModule } from '../inventory/inventory.module';

@Module({
  imports: [InventoryFeedModule, InventoryModule],
  controllers: [IntegrationsHealthController],
  providers: [
    SecretVaultService,
    CircuitBreakerService,
    OutboxService,
    WebhookInboxService,
    TekionProvider,
    VAutoFeedProvider,
    InventoryIngestionService,
    TekionCrmWritebackService,
  ],
  exports: [
    SecretVaultService,
    CircuitBreakerService,
    OutboxService,
    WebhookInboxService,
    TekionProvider,
    VAutoFeedProvider,
    InventoryIngestionService,
    TekionCrmWritebackService,
  ],
})
export class IntegrationsModule {}
