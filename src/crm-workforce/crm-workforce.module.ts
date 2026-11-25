import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SpotlightsModule } from '../spotlights/spotlights.module';
import { CrmWfActionService } from './action.service';
import { CrmAdapterRegistry } from './adapters/adapter.registry';
import { CrmWfDrafterService } from './agents/drafter.service';
import { CrmWfComplianceFactsService } from './compliance-facts.service';
import { CrmWfControlService } from './control.service';
import { CrmWorkforceController } from './crm-workforce.controller';
import { CrmWfEngineService } from './engine.service';
import { CrmWfFactsService } from './facts.service';
import { CrmWfImportService } from './import.service';
import { CrmWfIntakeService } from './intake.service';
import { CrmWfLeadControlService } from './lead-control.service';
import { CrmWfPrivacyService } from './privacy.service';
import { CrmWfQueueService } from './queue.service';
import { CrmWfReadService } from './read.service';
import { CrmWfSupervisorService } from './supervisor.service';
import { CrmWfSuppressionService } from './suppression.service';
import { CrmWfVaultService } from './vault.service';
import { CrmWfWorkItemService } from './work-item.service';
import { CrmWfAssistService } from './assist.service';
import { CrmWfMiningService } from './mining.service';
import { CrmWfDirectorService } from './director.service';

/**
 * AMQUR CRM Workforce — an additive division of the AMQUR platform (docs/CRM_WORKFORCE.md).
 * Reuses: model gateway, consent ledger, store hours, inventory feed, feature flags, turn
 * locks, circuit breaker, staff auth, audit log, Command Center. Adds nothing to the public
 * widget/chat surface and registers no handler in the existing outbox.
 */
@Module({
  imports: [PrismaModule, IntegrationsModule, ChatModule, SpotlightsModule],
  controllers: [CrmWorkforceController],
  providers: [
    CrmWfVaultService,
    CrmWfPrivacyService,
    CrmWfImportService,
    CrmWfWorkItemService,
    CrmWfAssistService,
    CrmWfMiningService,
    CrmWfDirectorService,
    CrmAdapterRegistry,
    CrmWfControlService,
    CrmWfSuppressionService,
    CrmWfQueueService,
    CrmWfIntakeService,
    CrmWfFactsService,
    CrmWfComplianceFactsService,
    CrmWfDrafterService,
    CrmWfSupervisorService,
    CrmWfActionService,
    CrmWfEngineService,
    CrmWfReadService,
    CrmWfLeadControlService,
  ],
  exports: [
    CrmWfEngineService,
    CrmAdapterRegistry,
    CrmWfIntakeService,
    CrmWfActionService,
    CrmWfControlService,
    CrmWfQueueService,
    CrmWfSupervisorService,
  ],
})
export class CrmWorkforceModule {}
