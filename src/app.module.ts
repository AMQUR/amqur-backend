import { ExperimentsModule } from './experiments/experiments.module';
import { SpotlightsModule } from './spotlights/spotlights.module';
import {
  MiddlewareConsumer,
  Module,
  NestModule,
  ExecutionContext,
} from '@nestjs/common';

import { isCredentialController } from './common/guards/credential-routes';
import { createThrottlerStorage } from './common/guards/redis-throttler.storage';
import { ConfigModule } from '@nestjs/config';
import { envValidationSchema } from './config/env.validation';
import { ThrottlerModule } from '@nestjs/throttler';
import { TenantThrottlerGuard } from './common/guards/tenant-throttler.guard';
import { rateLimit } from './common/rate-limits';
import { SecurityHeadersMiddleware } from './common/middleware/security-headers.middleware';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';

import { PrismaModule } from './prisma/prisma.module';
import { TenantsModule } from './tenants/tenants.module';
import { LocationsModule } from './locations/locations.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { ChatModule } from './chat/chat.module';
import { InventoryModule } from './inventory/inventory.module';
import { InventoryFeedModule } from './inventory-feed/inventory-feed.module';
import { InventorySyncModule } from './inventory-sync/inventory-sync.module';
import { PublicModule } from './public/public.module';
import { HealthModule } from './health/health.module';
import { LeadsModule } from './leads/leads.module';
import { EscalationsModule } from './escalations/escalations.module';
import { ObservabilityModule } from './observability/observability.module';
import { FeatureFlagsModule } from './feature-flags/feature-flags.module';
import { SourceAuthorityModule } from './source-authority/source-authority.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { AiModule } from './ai/ai.module';
import { SavedVehiclesModule } from './saved-vehicles/saved-vehicles.module';
import { PartsModule } from './parts/parts.module';
import { MessagingModule } from './messaging/messaging.module';
import { CopilotModule } from './copilot/copilot.module';
import { CapabilityModule } from './capability/capability.module';
import { CacheModule } from './cache/cache.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { DealerGroupsModule } from './dealer-groups/dealer-groups.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { TradeModule } from './trade/trade.module';
import { UploadsModule } from './uploads/uploads.module';
import { VoiceModule } from './voice/voice.module';
import { FinanceModule } from './finance/finance.module';
import { AppointmentsModule } from './appointments/appointments.module';
import { OperationsModule } from './operations/operations.module';
import { PrivacyModule } from './privacy/privacy.module';
import { ActionPagesModule } from './action-pages/action-pages.module';
import { DealsModule } from './deals/deals.module';
import { ReviewsModule } from './reviews/reviews.module';
import { DocumentsModule } from './documents/documents.module';
import { SurveysModule } from './surveys/surveys.module';
import { WorkflowLabModule } from './workflow-lab/workflow-lab.module';
import { ToolRegistryModule } from './tool-registry/tool-registry.module';
import { CrmWorkforceModule } from './crm-workforce/crm-workforce.module';

import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RolesGuard } from './auth/guards/roles.guard';
import { LoggerMiddleware } from './common/middleware/logger.middleware';

function isCredentialRoute(context: ExecutionContext): boolean {
  return isCredentialController(context.getClass()?.name);
}

@Module({
  imports: [
    SpotlightsModule,
    ExperimentsModule,
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      validationSchema: envValidationSchema,
      validationOptions: {
        abortEarly: true,
        allowUnknown: true,
      },
    }),

    ThrottlerModule.forRoot({
      // Shared across API replicas when REDIS_URL is set (per-process otherwise).
      storage: createThrottlerStorage(),
      throttlers: [
        {
          name: 'default',
          ttl: 60_000,
          // Higher ceiling in test/load labs; production stays 120/min.
          limit: rateLimit(120, 10_000),
        },
        {
          // Credential endpoints only (login, MFA, password, invite redemption). Without this
          // filter a named throttler applies to EVERY route, which capped the public widget
          // (config + token + chat on each page view) at 20 requests a minute per address.
          name: 'auth',
          ttl: 60_000,
          limit: rateLimit(20, 5_000),
          skipIf: (context) => !isCredentialRoute(context),
        },
      ],
    }),

    ScheduleModule.forRoot(),
    PrismaModule,
    CacheModule,
    FeatureFlagsModule,
    CapabilityModule,
    SourceAuthorityModule,
    AiModule,
    IntegrationsModule,
    TenantsModule,
    LocationsModule,
    UsersModule,
    AuthModule,
    PublicModule,
    OnboardingModule,
    DealerGroupsModule,
    HealthModule,
    LeadsModule,
    EscalationsModule,
    ObservabilityModule,
    SavedVehiclesModule,
    PartsModule,
    MessagingModule,
    CopilotModule,
    ChatModule,
    InventoryModule,
    InventoryFeedModule,
    InventorySyncModule,
    KnowledgeModule,
    AnalyticsModule,
    TradeModule,
    UploadsModule,
    VoiceModule,
    FinanceModule,
    AppointmentsModule,
    OperationsModule,
    PrivacyModule,
    ActionPagesModule,
    DealsModule,
    ReviewsModule,
    DocumentsModule,
    SurveysModule,
    WorkflowLabModule,
    ToolRegistryModule,
    CrmWorkforceModule,
  ],

  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    // Tenant-aware buckets: one dealership under load never drains another's.
    { provide: APP_GUARD, useClass: TenantThrottlerGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(SecurityHeadersMiddleware, LoggerMiddleware)
      .forRoutes('{*path}');
  }
}
