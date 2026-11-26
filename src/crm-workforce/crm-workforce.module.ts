import { Module, OnModuleInit } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SpotlightsModule } from '../spotlights/spotlights.module';
import { DealerKnowledgeModule } from '../dealer-knowledge/dealer-knowledge.module';
import { PrivacyModule } from '../privacy/privacy.module';
import { PrivacyService } from '../privacy/privacy.service';
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
import { CrmWfKeyRotationService } from './key-rotation.service';
import { CrmWfReportSchedulerService } from './report-scheduler.service';
import { CrmWfReplyIngestService } from './reply-ingest.service';
import { CrmWfQueueService } from './queue.service';
import { CrmWfReadService } from './read.service';
import { CrmWfSupervisorService } from './supervisor.service';
import { CrmWfSuppressionService } from './suppression.service';
import { CrmWfVaultService } from './vault.service';
import { CrmWfGroupScopeGuard } from './admin/group-scope.guard';
import { CrmWfStaffService } from './admin/staff.service';
import { CrmWfStaffLinkController } from './admin/staff-link.controller';
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
  imports: [
    PrismaModule,
    IntegrationsModule,
    ChatModule,
    SpotlightsModule,
    DealerKnowledgeModule,
    PrivacyModule,
  ],
  controllers: [CrmWorkforceController, CrmWfStaffLinkController],
  providers: [
    CrmWfVaultService,
    CrmWfStaffService,
    CrmWfGroupScopeGuard,
    CrmWfPrivacyService,
    CrmWfKeyRotationService,
    CrmWfReportSchedulerService,
    CrmWfReplyIngestService,
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
export class CrmWorkforceModule implements OnModuleInit {
  constructor(
    private readonly platformPrivacy: PrivacyService,
    private readonly crmPrivacy: CrmWfPrivacyService,
  ) {}

  /** Platform-wide privacy export and deletion also cover CRM Workforce data. */
  onModuleInit() {
    const actor = (tenantId: string, userId: string) => ({
      userId,
      role: 'ADMIN',
      tenantId,
    });
    this.platformPrivacy.register({
      key: 'crmWorkforce',
      export: (tenantId, userId, q) =>
        this.crmPrivacy.export(
          actor(tenantId, userId),
          tenantId,
          q,
          'platform privacy export',
        ),
      // Erase keeps the opt-out suppression (a keyed hash) so the customer stays opted out.
      erase: (tenantId, userId, q) =>
        this.crmPrivacy.erase(
          actor(tenantId, userId),
          tenantId,
          q,
          'platform privacy deletion',
        ),
    });
  }
}
