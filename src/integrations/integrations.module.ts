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
import { LeadsModule } from '../leads/leads.module';
import { MetaGraphLeadClientService } from './meta/meta-graph-lead.client';
import { MetaLeadsInboxProcessor } from './meta/meta-leads-inbox.processor';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { LeadDeliveryService } from './adf/lead-delivery.service';
import { LeadDeliveryRouteService } from './adf/lead-delivery-route.service';
import { LeadDeliveryOpsController } from './adf/lead-delivery-ops.controller';
import { SandboxSinkTransport } from './adf/transports/sandbox-sink.transport';
import { SmtpLeadTransport } from './adf/transports/smtp.transport';

@Module({
  imports: [
    InventoryFeedModule,
    InventoryModule,
    LeadsModule,
    FeatureFlagsModule,
  ],
  controllers: [
    IntegrationsHealthController,
    MetaLeadsWebhookController,
    LeadDeliveryOpsController,
  ],
  providers: [
    SecretVaultService,
    CircuitBreakerService,
    OutboxService,
    OutboxProcessorService,
    WebhookInboxService,
    MetaLeadsWebhookService,
    MetaGraphLeadClientService,
    MetaLeadsInboxProcessor,
    TekionProvider,
    VAutoFeedProvider,
    NormalizedInventoryHttpProvider,
    InventoryIngestionService,
    TekionCrmWritebackService,
    SandboxSinkTransport,
    SmtpLeadTransport,
    LeadDeliveryRouteService,
    LeadDeliveryService,
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
    MetaLeadsInboxProcessor,
    SandboxSinkTransport,
    LeadDeliveryRouteService,
    LeadDeliveryService,
  ],
})
export class IntegrationsModule {}
