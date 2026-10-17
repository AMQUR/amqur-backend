import { Module } from '@nestjs/common';
import { SecretVaultService } from './core/secret-vault.service';
import { CircuitBreakerService } from './core/circuit-breaker.service';
import { OutboxService } from './core/outbox.service';
import { OutboxProcessorService } from './core/outbox-processor.service';
import { TekionProvider } from './tekion/tekion.provider';
import { VAutoFeedProvider } from './vauto/vauto-feed.provider';
import { InventoryIngestionService } from './vauto/inventory-ingestion.service';
import { TekionCrmWritebackService } from './tekion/tekion-crm-writeback.service';
import { IntegrationsHealthController } from './integrations-health.controller';
import { WebhookInboxService } from './core/webhook-inbox.service';
import { MetaLeadsWebhookController } from './meta/meta-leads-webhook.controller';
import { MetaLeadsWebhookService } from './meta/meta-leads-webhook.service';
import { InventoryFeedModule } from '../inventory-feed/inventory-feed.module';
import { InventoryModule } from '../inventory/inventory.module';
import { NormalizedInventoryHttpProvider } from './normalized-inventory/normalized-inventory-http.provider';
import { CrmSyncService } from './crm/crm-sync.service';

@Module({
  imports: [InventoryFeedModule, InventoryModule],
  controllers: [IntegrationsHealthController, MetaLeadsWebhookController],
  providers: [
    SecretVaultService,
    CircuitBreakerService,
    OutboxService,
    OutboxProcessorService,
    WebhookInboxService,
    MetaLeadsWebhookService,
    TekionProvider,
    VAutoFeedProvider,
    NormalizedInventoryHttpProvider,
    InventoryIngestionService,
    TekionCrmWritebackService,
    CrmSyncService,
  ],
  exports: [
    SecretVaultService,
    CircuitBreakerService,
    OutboxService,
    OutboxProcessorService,
    WebhookInboxService,
    TekionProvider,
    VAutoFeedProvider,
    NormalizedInventoryHttpProvider,
    InventoryIngestionService,
    TekionCrmWritebackService,
    CrmSyncService,
  ],
})
export class IntegrationsModule {}
